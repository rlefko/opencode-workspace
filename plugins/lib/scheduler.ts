/**
 * scheduler
 * Tiered concurrency control for local model servers.
 *
 * Each tier ("top", "fast") has a fixed number of slots. Background work
 * (delegations, native task calls, workflow agents) must hold a slot lease
 * while its model generates; foreground/interactive sessions never acquire.
 *
 * Cross-process mode shares slots between every opencode instance on the
 * machine through lease files under <leaseDir>/<tier>/slot-N.json. Slot files
 * are created with O_EXCL (atomic), refreshed by heartbeat, and reaped when
 * their owning process dies or stops heartbeating.
 *
 * Within a process the waiters form a strict FIFO queue per tier. Across
 * processes ordering is best effort (jittered polling).
 */

import * as crypto from "node:crypto"
import { readFileSync, unlinkSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { HarnessConfig, TierConfig } from "./harness-config"

export type LeaseKind = "delegate" | "task" | "workflow"

export interface LeaseInfo {
	version: 1
	tier: string
	slot: number
	pid: number
	hostname: string
	kind: LeaseKind
	agent?: string
	sessionID?: string
	jobId?: string
	acquiredAt: number
	heartbeatAt: number
}

export interface Lease {
	readonly info: LeaseInfo
	release(): Promise<void>
}

export interface AcquireOptions {
	kind: LeaseKind
	agent?: string
	sessionID?: string
	jobId?: string
	signal?: AbortSignal
	/** Max queue wait in ms. 0 or undefined = wait indefinitely. */
	maxWaitMs?: number
	onQueued?: (position: number) => void
}

export interface TierStatus {
	name: string
	maxConcurrent: number
	holders: LeaseInfo[]
	localQueue: Array<{ kind: LeaseKind; jobId?: string; agent?: string; waitingMs: number }>
}

export class AcquireAbortedError extends Error {
	constructor(tier: string) {
		super(`Slot acquisition for tier "${tier}" was aborted`)
		this.name = "AcquireAbortedError"
	}
}

export class QueueWaitTimeoutError extends Error {
	constructor(tier: string, waitedMs: number) {
		super(`Timed out after ${Math.round(waitedMs / 1000)}s waiting for a "${tier}" slot`)
		this.name = "QueueWaitTimeoutError"
	}
}

interface SchedulerLogger {
	info(message: string): void
	warn(message: string): void
}

const NOOP_LOGGER: SchedulerLogger = { info: () => {}, warn: () => {} }

interface Waiter {
	opts: AcquireOptions
	enqueuedAt: number
	resolve(lease: Lease): void
	reject(error: Error): void
	settled: boolean
	attemptInFlight?: boolean
	waitTimer?: ReturnType<typeof setTimeout>
	pollTimer?: ReturnType<typeof setTimeout>
	abortListener?: () => void
}

interface HeldLease {
	info: LeaseInfo
	filePath?: string
	released: boolean
	lost: boolean
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		return code === "EPERM"
	}
}

export class TierScheduler {
	private readonly cfg: HarnessConfig
	private readonly log: SchedulerLogger
	private readonly tiersByName = new Map<string, TierConfig>()
	private readonly queues = new Map<string, Waiter[]>()
	private readonly held = new Map<string, HeldLease>() // key: tier:slot
	private readonly inMemoryCounts = new Map<string, number>()
	private heartbeatTimer?: ReturnType<typeof setInterval>
	private exitHookInstalled = false
	private initPromise?: Promise<void>
	private disposed = false
	private inMemorySlotCounter = 0

	constructor(cfg: HarnessConfig, log: SchedulerLogger = NOOP_LOGGER) {
		this.cfg = cfg
		this.log = log
		for (const tier of cfg.tiers) {
			this.tiersByName.set(tier.name, tier)
			this.queues.set(tier.name, [])
			this.inMemoryCounts.set(tier.name, 0)
		}
	}

	init(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.doInit().catch((error) => {
				this.log.warn(`scheduler: init failed: ${String(error)}`)
			})
		}
		return this.initPromise
	}

	private async doInit(): Promise<void> {
		if (!this.cfg.scheduler.crossProcess) return
		for (const tier of this.tiersByName.values()) {
			const tierDir = this.tierDir(tier.name)
			await fs.mkdir(tierDir, { recursive: true })
			await this.sweepTierDir(tier)
		}
		this.installExitHook()
	}

	/** Map a "providerID/modelID" string to a tier name, or defaultTier on miss. */
	classify(model: string): string | null {
		const normalized = model.trim().toLowerCase()
		for (const tier of this.tiersByName.values()) {
			if (tier.models.some((m) => m.trim().toLowerCase() === normalized)) {
				return tier.name
			}
		}
		return this.cfg.defaultTier
	}

	async acquire(tierName: string, opts: AcquireOptions): Promise<Lease> {
		const tier = this.tiersByName.get(tierName)
		if (!tier) {
			throw new Error(`Unknown scheduler tier "${tierName}"`)
		}
		if (opts.signal?.aborted) {
			throw new AcquireAbortedError(tierName)
		}

		// No fast path while waiters exist: newcomers must not barge ahead of the
		// FIFO queue when a slot happens to be free at call time.
		const existingQueue = this.queues.get(tierName)
		if (!existingQueue || existingQueue.length === 0) {
			const immediate = await this.tryAcquireSlot(tier, opts)
			if (opts.signal?.aborted) {
				if (immediate) await immediate.release()
				throw new AcquireAbortedError(tierName)
			}
			if (immediate) return immediate
		}

		return await new Promise<Lease>((resolve, reject) => {
			const queue = this.queues.get(tierName)
			if (!queue) {
				reject(new Error(`Unknown scheduler tier "${tierName}"`))
				return
			}

			const waiter: Waiter = {
				opts,
				enqueuedAt: Date.now(),
				settled: false,
				resolve: (lease) => {
					if (waiter.settled) {
						void lease.release()
						return
					}
					waiter.settled = true
					this.detachWaiter(tierName, waiter)
					resolve(lease)
				},
				reject: (error) => {
					if (waiter.settled) return
					waiter.settled = true
					this.detachWaiter(tierName, waiter)
					reject(error)
				},
			}

			queue.push(waiter)
			opts.onQueued?.(queue.length)

			const maxWaitMs = opts.maxWaitMs ?? this.cfg.timeouts.queueWaitMs
			if (maxWaitMs > 0) {
				waiter.waitTimer = setTimeout(() => {
					waiter.reject(new QueueWaitTimeoutError(tierName, Date.now() - waiter.enqueuedAt))
				}, maxWaitMs)
				waiter.waitTimer.unref?.()
			}

			if (opts.signal) {
				waiter.abortListener = () => waiter.reject(new AcquireAbortedError(tierName))
				opts.signal.addEventListener("abort", waiter.abortListener, { once: true })
				// A signal that aborted between the awaits above never fires the
				// listener; reject explicitly so the waiter cannot queue forever.
				if (opts.signal.aborted) {
					waiter.reject(new AcquireAbortedError(tierName))
					return
				}
			}

			this.pumpQueue(tier)
		})
	}

	async status(): Promise<TierStatus[]> {
		const statuses: TierStatus[] = []
		const now = Date.now()
		for (const tier of this.tiersByName.values()) {
			const holders = this.cfg.scheduler.crossProcess
				? await this.scanTierHolders(tier)
				: Array.from(this.held.values())
						.filter((lease) => !lease.released && lease.info.tier === tier.name)
						.map((lease) => lease.info)
			const queue = this.queues.get(tier.name) ?? []
			statuses.push({
				name: tier.name,
				maxConcurrent: tier.maxConcurrent,
				holders,
				localQueue: queue.map((waiter) => ({
					kind: waiter.opts.kind,
					jobId: waiter.opts.jobId,
					agent: waiter.opts.agent,
					waitingMs: now - waiter.enqueuedAt,
				})),
			})
		}
		return statuses
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		for (const queue of this.queues.values()) {
			for (const waiter of [...queue]) {
				waiter.reject(new AcquireAbortedError(waiter.opts.kind))
			}
		}
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = undefined
		}
		for (const lease of [...this.held.values()]) {
			await this.releaseLease(lease)
		}
	}

	// ==========================================
	// Slot acquisition
	// ==========================================

	private tierDir(tierName: string): string {
		return path.join(this.cfg.scheduler.leaseDir, tierName)
	}

	private slotPath(tierName: string, slot: number): string {
		return path.join(this.tierDir(tierName), `slot-${slot}.json`)
	}

	private heldKey(tierName: string, slot: number): string {
		return `${tierName}:${slot}`
	}

	private async tryAcquireSlot(tier: TierConfig, opts: AcquireOptions): Promise<Lease | null> {
		if (!this.cfg.scheduler.crossProcess) {
			const count = this.inMemoryCounts.get(tier.name) ?? 0
			if (count >= tier.maxConcurrent) return null
			this.inMemoryCounts.set(tier.name, count + 1)
			// Monotonic slot ids: reusing the current count as the id collides in
			// the held map after release-then-acquire churn.
			const lease = this.buildHeldLease(tier, ++this.inMemorySlotCounter, opts, undefined)
			return this.toLease(lease)
		}

		for (let slot = 0; slot < tier.maxConcurrent; slot++) {
			const acquired = await this.tryAcquireSlotFile(tier, slot, opts)
			if (acquired) return acquired
		}
		return null
	}

	private async tryAcquireSlotFile(
		tier: TierConfig,
		slot: number,
		opts: AcquireOptions,
	): Promise<Lease | null> {
		const filePath = this.slotPath(tier.name, slot)

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await fs.open(filePath, "wx")
				const lease = this.buildHeldLease(tier, slot, opts, filePath)
				try {
					await handle.writeFile(JSON.stringify(lease.info, null, "\t"), "utf8")
					await handle.close()
				} catch (writeError) {
					// A half-written slot file with a registered held entry would leak
					// capacity; clean both up and treat the slot as unavailable.
					await handle.close().catch(() => {})
					this.held.delete(this.heldKey(tier.name, slot))
					await fs.unlink(filePath).catch(() => {})
					this.log.warn(`scheduler: slot write failed for ${filePath}: ${String(writeError)}`)
					return null
				}
				this.startHeartbeat()
				return this.toLease(lease)
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "ENOENT") {
					await fs.mkdir(this.tierDir(tier.name), { recursive: true }).catch(() => {})
					continue
				}
				if (code !== "EEXIST") {
					this.log.warn(`scheduler: slot create failed for ${filePath}: ${String(error)}`)
					return null
				}
				const stale = await this.isSlotStale(filePath)
				if (!stale) return null
				const reaped = await this.reapSlot(filePath)
				if (!reaped) return null
				// Reaped a stale lease; loop once more to attempt the O_EXCL create.
			}
		}
		return null
	}

	private async isSlotStale(filePath: string): Promise<boolean> {
		let info: LeaseInfo
		try {
			const raw = await fs.readFile(filePath, "utf8")
			info = JSON.parse(raw) as LeaseInfo
		} catch {
			return true
		}
		if (
			typeof info?.pid !== "number" ||
			typeof info?.heartbeatAt !== "number" ||
			info.version !== 1
		) {
			return true
		}
		if (info.hostname === os.hostname() && !pidAlive(info.pid)) {
			return true
		}
		return Date.now() - info.heartbeatAt > this.cfg.scheduler.staleMs
	}

	private async reapSlot(filePath: string): Promise<boolean> {
		const reapPath = path.join(path.dirname(filePath), `.reap-${crypto.randomUUID()}`)
		try {
			await fs.rename(filePath, reapPath)
		} catch {
			// Another process won the reap race; treat the slot as contended.
			return false
		}
		await fs.unlink(reapPath).catch(() => {})
		this.log.info(`scheduler: reaped stale lease ${path.basename(filePath)}`)
		return true
	}

	private async sweepTierDir(tier: TierConfig): Promise<void> {
		const tierDir = this.tierDir(tier.name)
		let entries: string[]
		try {
			entries = await fs.readdir(tierDir)
		} catch {
			return
		}
		for (const entry of entries) {
			const entryPath = path.join(tierDir, entry)
			if (entry.startsWith(".reap-")) {
				const stat = await fs.stat(entryPath).catch(() => null)
				if (stat && Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
					await fs.unlink(entryPath).catch(() => {})
				}
				continue
			}
			if (entry.startsWith("slot-") && (await this.isSlotStale(entryPath))) {
				await this.reapSlot(entryPath)
			}
		}
	}

	private async scanTierHolders(tier: TierConfig): Promise<LeaseInfo[]> {
		const tierDir = this.tierDir(tier.name)
		let entries: string[]
		try {
			entries = await fs.readdir(tierDir)
		} catch {
			return []
		}
		const holders: LeaseInfo[] = []
		for (const entry of entries) {
			if (!entry.startsWith("slot-") || !entry.endsWith(".json")) continue
			const entryPath = path.join(tierDir, entry)
			if (await this.isSlotStale(entryPath)) {
				await this.reapSlot(entryPath)
				continue
			}
			try {
				const raw = await fs.readFile(entryPath, "utf8")
				holders.push(JSON.parse(raw) as LeaseInfo)
			} catch {
				// Racing a release; skip.
			}
		}
		return holders.sort((a, b) => a.slot - b.slot)
	}

	// ==========================================
	// Lease lifecycle
	// ==========================================

	private buildHeldLease(
		tier: TierConfig,
		slot: number,
		opts: AcquireOptions,
		filePath: string | undefined,
	): HeldLease {
		const now = Date.now()
		const lease: HeldLease = {
			info: {
				version: 1,
				tier: tier.name,
				slot,
				pid: process.pid,
				hostname: os.hostname(),
				kind: opts.kind,
				agent: opts.agent,
				sessionID: opts.sessionID,
				jobId: opts.jobId,
				acquiredAt: now,
				heartbeatAt: now,
			},
			filePath,
			released: false,
			lost: false,
		}
		this.held.set(this.heldKey(tier.name, slot), lease)
		return lease
	}

	private toLease(lease: HeldLease): Lease {
		return {
			info: lease.info,
			release: () => this.releaseLease(lease),
		}
	}

	private async releaseLease(lease: HeldLease): Promise<void> {
		if (lease.released) return
		lease.released = true
		this.held.delete(this.heldKey(lease.info.tier, lease.info.slot))

		if (!this.cfg.scheduler.crossProcess) {
			const count = this.inMemoryCounts.get(lease.info.tier) ?? 0
			this.inMemoryCounts.set(lease.info.tier, Math.max(0, count - 1))
		} else if (lease.filePath && !lease.lost) {
			// Verify ownership before unlinking: if we were reaped (e.g. after a
			// sleep) another process may have re-acquired this slot path, and
			// deleting its live lease would silently break the tier cap.
			try {
				const current = JSON.parse(await fs.readFile(lease.filePath, "utf8")) as LeaseInfo
				if (current.pid === process.pid && current.acquiredAt === lease.info.acquiredAt) {
					await fs.unlink(lease.filePath).catch(() => {})
				}
			} catch {
				// File already gone or unreadable; nothing to release on disk.
			}
		}

		if (this.held.size === 0 && this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = undefined
		}

		const tier = this.tiersByName.get(lease.info.tier)
		if (tier) this.pumpQueue(tier)
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer || !this.cfg.scheduler.crossProcess) return
		this.heartbeatTimer = setInterval(() => {
			void this.heartbeatHeldLeases()
		}, this.cfg.scheduler.heartbeatMs)
		this.heartbeatTimer.unref?.()
	}

	private async heartbeatHeldLeases(): Promise<void> {
		for (const lease of this.held.values()) {
			if (lease.released || lease.lost || !lease.filePath) continue

			let current: LeaseInfo | undefined
			try {
				current = JSON.parse(await fs.readFile(lease.filePath, "utf8")) as LeaseInfo
			} catch {
				current = undefined
			}
			if (!current || current.pid !== process.pid || current.acquiredAt !== lease.info.acquiredAt) {
				// We were reaped (e.g. the machine slept past staleMs). Do not recreate:
				// capacity may already have been handed to another process.
				lease.lost = true
				this.log.warn(
					`scheduler: lease ${lease.info.tier}/slot-${lease.info.slot} was reaped externally; continuing without it`,
				)
				continue
			}

			// If our own on-disk heartbeat is already stale (we slept past staleMs),
			// another process may reap and re-acquire this slot at any moment.
			// Renaming over it could clobber their fresh lease; surrender instead.
			if (Date.now() - current.heartbeatAt > this.cfg.scheduler.staleMs) {
				lease.lost = true
				this.log.warn(
					`scheduler: lease ${lease.info.tier}/slot-${lease.info.slot} went stale (slept?); surrendering it`,
				)
				continue
			}

			lease.info.heartbeatAt = Date.now()
			const tmpPath = `${lease.filePath}.tmp-${process.pid}`
			try {
				await fs.writeFile(tmpPath, JSON.stringify(lease.info, null, "\t"), "utf8")
				if (lease.released) {
					// Released while we were writing; do not resurrect the slot file.
					await fs.unlink(tmpPath).catch(() => {})
					continue
				}
				await fs.rename(tmpPath, lease.filePath)
				if (lease.released) {
					// Release raced the rename; remove the file we just recreated.
					await fs.unlink(lease.filePath).catch(() => {})
				}
			} catch (error) {
				await fs.unlink(tmpPath).catch(() => {})
				this.log.warn(`scheduler: heartbeat failed for ${lease.filePath}: ${String(error)}`)
			}
		}
	}

	private installExitHook(): void {
		if (this.exitHookInstalled) return
		this.exitHookInstalled = true
		process.on("exit", () => {
			for (const lease of this.held.values()) {
				if (lease.released || lease.lost || !lease.filePath) continue
				try {
					// Best-effort synchronous cleanup; crash-kill is covered by stale reaping.
					// Only unlink if the file is still ours (we may have been reaped).
					const current = JSON.parse(readFileSync(lease.filePath, "utf8")) as LeaseInfo
					if (current.pid === process.pid && current.acquiredAt === lease.info.acquiredAt) {
						unlinkSync(lease.filePath)
					}
				} catch {
					// Ignore: file already gone or unreadable.
				}
			}
		})
	}

	// ==========================================
	// Queue pump
	// ==========================================

	private detachWaiter(tierName: string, waiter: Waiter): void {
		const queue = this.queues.get(tierName)
		if (queue) {
			const index = queue.indexOf(waiter)
			if (index >= 0) queue.splice(index, 1)
		}
		if (waiter.waitTimer) clearTimeout(waiter.waitTimer)
		if (waiter.pollTimer) clearTimeout(waiter.pollTimer)
		if (waiter.abortListener && waiter.opts.signal) {
			waiter.opts.signal.removeEventListener("abort", waiter.abortListener)
		}
		const tier = this.tiersByName.get(tierName)
		if (tier) this.pumpQueue(tier)
	}

	private pumpQueue(tier: TierConfig): void {
		const queue = this.queues.get(tier.name)
		if (!queue || queue.length === 0) return
		const head = queue[0]
		if (head.settled || head.attemptInFlight) return

		// A release should hand the slot to the head immediately, not after the
		// current poll interval elapses: cancel any scheduled poll and try now.
		if (head.pollTimer) {
			clearTimeout(head.pollTimer)
			head.pollTimer = undefined
		}

		const attempt = async () => {
			head.pollTimer = undefined
			if (head.settled || head.attemptInFlight) return
			head.attemptInFlight = true
			try {
				const lease = await this.tryAcquireSlot(tier, head.opts).catch(() => null)
				if (head.settled) {
					if (lease) void lease.release()
					return
				}
				if (lease) {
					head.resolve(lease)
					return
				}
				// Jittered retry keeps multiple waiting processes from polling in lockstep.
				const jitter = 0.8 + Math.random() * 0.4
				head.pollTimer = setTimeout(() => void attempt(), this.cfg.scheduler.pollMs * jitter)
				head.pollTimer.unref?.()
			} finally {
				head.attemptInFlight = false
			}
		}

		head.pollTimer = setTimeout(() => void attempt(), 0)
	}
}

let singleton: TierScheduler | undefined

/**
 * Per-process singleton. Plugins share this via Bun's module cache; the first
 * caller's config wins.
 */
export function getScheduler(cfg: HarnessConfig, log?: SchedulerLogger): TierScheduler {
	if (!singleton) {
		singleton = new TierScheduler(cfg, log)
		void singleton.init()
	}
	return singleton
}

/** Test hook: clear the singleton so isolated instances can be constructed. */
export function resetSchedulerForTests(): void {
	singleton = undefined
}
