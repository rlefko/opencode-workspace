import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { HARNESS_DEFAULTS, type HarnessConfig } from "./harness-config"
import { AcquireAbortedError, QueueWaitTimeoutError, TierScheduler } from "./scheduler"
import { splitModelRef } from "./tiers"

function makeConfig(overrides: Partial<HarnessConfig["scheduler"]> = {}): HarnessConfig {
	return {
		...HARNESS_DEFAULTS,
		tiers: [
			{ name: "top", models: ["lmstudio/qwen/qwen3.6-27b"], maxConcurrent: 1 },
			{ name: "fast", models: ["lmstudio/qwen/qwen3.6-35b-a3b"], maxConcurrent: 3 },
		],
		scheduler: { ...HARNESS_DEFAULTS.scheduler, crossProcess: false, pollMs: 50, ...overrides },
	}
}

const schedulers: TierScheduler[] = []

function makeScheduler(cfg: HarnessConfig): TierScheduler {
	const scheduler = new TierScheduler(cfg)
	schedulers.push(scheduler)
	return scheduler
}

afterEach(async () => {
	for (const scheduler of schedulers.splice(0)) {
		await scheduler.dispose()
	}
})

describe("classify", () => {
	test("maps known models to tiers and unknown models to defaultTier", () => {
		const scheduler = makeScheduler(makeConfig())
		expect(scheduler.classify("lmstudio/qwen/qwen3.6-27b")).toBe("top")
		expect(scheduler.classify("LMSTUDIO/QWEN/QWEN3.6-35B-A3B")).toBe("fast")
		expect(scheduler.classify("anthropic/claude-sonnet-5")).toBeNull()
	})

	test("respects a non-null defaultTier", () => {
		const cfg = { ...makeConfig(), defaultTier: "fast" }
		const scheduler = makeScheduler(cfg)
		expect(scheduler.classify("anthropic/claude-sonnet-5")).toBe("fast")
	})
})

describe("splitModelRef", () => {
	test("splits on the first slash only", () => {
		expect(splitModelRef("lmstudio/qwen/qwen3.6-27b")).toEqual({
			providerID: "lmstudio",
			modelID: "qwen/qwen3.6-27b",
		})
	})

	test("rejects malformed refs", () => {
		expect(splitModelRef("no-slash")).toBeUndefined()
		expect(splitModelRef("trailing/")).toBeUndefined()
		expect(splitModelRef("/leading")).toBeUndefined()
	})
})

describe("in-memory semaphore", () => {
	test("caps concurrency and hands off in FIFO order", async () => {
		const scheduler = makeScheduler(makeConfig())
		await scheduler.init()

		const order: number[] = []
		const leases = await Promise.all(
			[0, 1, 2].map((n) =>
				scheduler.acquire("fast", { kind: "delegate", jobId: `job-${n}` }).then((lease) => {
					order.push(n)
					return lease
				}),
			),
		)
		expect(order.sort()).toEqual([0, 1, 2])

		let fourthAcquired = false
		const fourth = scheduler
			.acquire("fast", { kind: "delegate", jobId: "job-3" })
			.then((lease) => {
				fourthAcquired = true
				return lease
			})

		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(fourthAcquired).toBe(false)

		await leases[0].release()
		const fourthLease = await fourth
		expect(fourthAcquired).toBe(true)

		await fourthLease.release()
		for (const lease of leases.slice(1)) await lease.release()
	})

	test("abort while queued rejects with AcquireAbortedError", async () => {
		const scheduler = makeScheduler(makeConfig())
		await scheduler.init()
		const first = await scheduler.acquire("top", { kind: "delegate" })

		const controller = new AbortController()
		const pending = scheduler.acquire("top", { kind: "delegate", signal: controller.signal })
		controller.abort()
		await expect(pending).rejects.toBeInstanceOf(AcquireAbortedError)
		await first.release()
	})

	test("maxWaitMs rejects with QueueWaitTimeoutError", async () => {
		const scheduler = makeScheduler(makeConfig())
		await scheduler.init()
		const first = await scheduler.acquire("top", { kind: "delegate" })
		const pending = scheduler.acquire("top", { kind: "delegate", maxWaitMs: 80 })
		await expect(pending).rejects.toBeInstanceOf(QueueWaitTimeoutError)
		await first.release()
	})

	test("release is idempotent", async () => {
		const scheduler = makeScheduler(makeConfig())
		await scheduler.init()
		const lease = await scheduler.acquire("top", { kind: "task" })
		await lease.release()
		await lease.release()
		const again = await scheduler.acquire("top", { kind: "task" })
		await again.release()
	})
})

describe("cross-process lease files", () => {
	test("two scheduler instances share slot capacity through the lease dir", async () => {
		const leaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-test-"))
		const cfg: HarnessConfig = {
			...makeConfig(),
			scheduler: {
				...HARNESS_DEFAULTS.scheduler,
				crossProcess: true,
				leaseDir,
				pollMs: 50,
				heartbeatMs: 1000,
				staleMs: 5000,
			},
		}
		const a = makeScheduler(cfg)
		const b = makeScheduler(cfg)
		await a.init()
		await b.init()

		const leaseA = await a.acquire("top", { kind: "delegate", jobId: "from-a" })
		let bAcquired = false
		const pendingB = b.acquire("top", { kind: "delegate", jobId: "from-b" }).then((lease) => {
			bAcquired = true
			return lease
		})

		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(bAcquired).toBe(false)

		const statusB = await b.status()
		const topStatus = statusB.find((t) => t.name === "top")
		expect(topStatus?.holders).toHaveLength(1)
		expect(topStatus?.holders[0]?.jobId).toBe("from-a")

		await leaseA.release()
		const leaseB = await pendingB
		expect(bAcquired).toBe(true)
		await leaseB.release()

		await fs.rm(leaseDir, { recursive: true, force: true })
	})

	test("stale leases from dead processes are reaped", async () => {
		const leaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-test-"))
		const cfg: HarnessConfig = {
			...makeConfig(),
			scheduler: {
				...HARNESS_DEFAULTS.scheduler,
				crossProcess: true,
				leaseDir,
				pollMs: 50,
				heartbeatMs: 1000,
				staleMs: 5000,
			},
		}
		const tierDir = path.join(leaseDir, "top")
		await fs.mkdir(tierDir, { recursive: true })
		await fs.writeFile(
			path.join(tierDir, "slot-0.json"),
			JSON.stringify({
				version: 1,
				tier: "top",
				slot: 0,
				pid: 999999999,
				hostname: os.hostname(),
				kind: "delegate",
				acquiredAt: Date.now() - 60_000,
				heartbeatAt: Date.now() - 60_000,
			}),
			"utf8",
		)

		const scheduler = makeScheduler(cfg)
		await scheduler.init()
		const lease = await scheduler.acquire("top", { kind: "delegate", jobId: "reclaimer" })
		expect(lease.info.jobId).toBe("reclaimer")
		await lease.release()
		await fs.rm(leaseDir, { recursive: true, force: true })
	})
})
