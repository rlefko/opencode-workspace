/**
 * background-agents
 * Unified delegation system for OpenCode
 *
 * Replaces native `task` tool with persistent, async-first agent delegation.
 * All agent outputs are persisted to storage, orchestrator receives only key references.
 *
 * Based on oh-my-opencode by @code-yeongyu (MIT License)
 * https://github.com/code-yeongyu/oh-my-opencode
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import type { Event, Message, Part, ReasoningPart, TextPart } from "@opencode-ai/sdk"
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { getProjectId } from "./kdco-primitives/get-project-id"
import type { OpencodeClient } from "./kdco-primitives/types"
import {
	type DelegationOutcome,
	registerDelegationHandle,
	type WorkflowDelegateOptions,
} from "./lib/delegation-registry"
import {
	HARNESS_DEFAULTS,
	type HarnessConfig,
	loadHarnessConfig,
} from "./lib/harness-config"
import {
	AcquireAbortedError,
	getScheduler,
	type Lease,
	QueueWaitTimeoutError,
	type TierScheduler,
} from "./lib/scheduler"
import { createTierResolver, splitModelRef, type TierResolver } from "./lib/tiers"

// ==========================================
// READABLE ID GENERATION
// ==========================================

function generateReadableId(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
		length: 3,
		style: "lowerCase",
	})
}

// ==========================================
// METADATA GENERATION (using small_model)
// ==========================================

interface GeneratedMetadata {
	title: string
	description: string
}

/**
 * Free title/description from truncation. The default path: no extra LLM call
 * per delegation (harness.jsonc metadata.useLlm re-enables the model version).
 */
function truncationMetadata(resultContent: string): GeneratedMetadata {
	const firstLine =
		resultContent.split("\n").find((l) => l.trim().length > 0) || "Delegation result"
	const title = firstLine.slice(0, 30).trim() + (firstLine.length > 30 ? "..." : "")
	const description =
		resultContent.slice(0, 150).trim() + (resultContent.length > 150 ? "..." : "")
	return { title, description }
}

/**
 * Generate title and description from result content using small_model
 * Falls back to truncation if small_model unavailable
 */
async function generateMetadata(
	client: OpencodeClient,
	resultContent: string,
	parentID: string,
	debugLog: (msg: string) => Promise<void>,
): Promise<GeneratedMetadata> {
	const fallbackMetadata = (): GeneratedMetadata => {
		// Fallback: truncate first line/paragraph
		const firstLine =
			resultContent.split("\n").find((l) => l.trim().length > 0) || "Delegation result"
		const title = firstLine.slice(0, 30).trim() + (firstLine.length > 30 ? "..." : "")
		const description =
			resultContent.slice(0, 150).trim() + (resultContent.length > 150 ? "..." : "")
		return { title, description }
	}

	try {
		// Get config to check for small_model
		const config = await client.config.get()
		const configData = config.data as { small_model?: string } | undefined

		if (!configData?.small_model) {
			await debugLog("generateMetadata: No small_model configured, using fallback")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Using small_model ${configData.small_model}`)

		// Create a session for metadata generation
		const session = await client.session.create({
			body: {
				title: "Metadata Generation",
				parentID,
			},
		})

		if (!session.data?.id) {
			await debugLog("generateMetadata: Failed to create session")
			return fallbackMetadata()
		}

		// Prompt the small model for metadata
		const prompt = `Generate a title and description for this research result.

RULES:
- Title: 2-5 words, max 30 characters, sentence case
- Description: 2-3 sentences, max 150 characters, summarize key findings

RESULT CONTENT:
${resultContent.slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`

		// Await prompt response directly with timeout safety net
		const PROMPT_TIMEOUT_MS = 30000
		const result = await Promise.race([
			client.session.prompt({
				path: { id: session.data.id },
				body: {
					parts: [{ type: "text", text: prompt }],
				},
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Prompt timeout after 30s")), PROMPT_TIMEOUT_MS),
			),
		])

		// Extract text from the response
		const responseParts = result.data?.parts as TextPart[] | undefined
		const textPart = responseParts?.find((p): p is TextPart => p.type === "text")
		if (!textPart) {
			await debugLog("generateMetadata: No text part in response")
			return fallbackMetadata()
		}

		// Parse JSON response
		const jsonMatch = textPart.text.match(/\{[\s\S]*\}/)
		if (!jsonMatch) {
			await debugLog(`generateMetadata: No JSON found in response: ${textPart.text}`)
			return fallbackMetadata()
		}

		const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string }
		if (!parsed.title || !parsed.description) {
			await debugLog("generateMetadata: Invalid JSON structure")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Generated title="${parsed.title}"`)
		return {
			title: parsed.title.slice(0, 30),
			description: parsed.description.slice(0, 150),
		}
	} catch (error) {
		await debugLog(
			`generateMetadata error: ${error instanceof Error ? error.message : "Unknown error"}`,
		)
		return fallbackMetadata()
	}
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface SessionMessageItem {
	info: Message
	parts: Part[]
}

interface AssistantSessionMessageItem {
	info: Message & { role: "assistant" }
	parts: Part[]
}

type DelegationStatus =
	| "registered"
	| "queued"
	| "running"
	| "complete"
	| "error"
	| "cancelled"
	| "timeout"

type DelegationTerminalStatus = Extract<
	DelegationStatus,
	"complete" | "error" | "cancelled" | "timeout"
>

interface DelegationProgress {
	toolCalls: number
	lastUpdateAt: Date
	lastHeartbeatAt: Date
	lastMessage?: string
	lastMessageAt?: Date
}

interface DelegationNotificationState {
	terminalNotifiedAt?: Date
	terminalNotificationCount: number
}

interface ParentNotificationState {
	allCompleteNotifiedAt?: Date
	allCompleteNotificationCount: number
	allCompleteCycle: number
	allCompleteCycleToken: string
	allCompleteNotifiedCycle?: number
	allCompleteNotifiedCycleToken?: string
	allCompleteScheduledCycle?: number
	allCompleteScheduledCycleToken?: string
	allCompleteScheduledTimer?: ReturnType<typeof setTimeout>
}

interface DelegationRetrievalState {
	retrievedAt?: Date
	retrievalCount: number
	lastReaderSessionID?: string
}

interface DelegationArtifactState {
	filePath: string
	persistedAt?: Date
	byteLength?: number
	persistError?: string
}

interface DelegationRecord {
	id: string
	rootSessionID: string
	sessionID: string
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	tier: string | null
	modelOverride?: string
	silent: boolean
	queuePosition?: number
	/** Terminal status an abort-initiating caller intends; beats idle's "complete". */
	pendingTerminalStatus?: DelegationTerminalStatus
	notificationCycle: number
	notificationCycleToken: string
	status: DelegationStatus
	createdAt: Date
	startedAt?: Date
	dispatchedAt?: Date
	completedAt?: Date
	updatedAt: Date
	timeoutAt?: Date
	lastActivityAt: Date
	/** callID -> started-at ms for tool calls in flight inside this session. */
	activeToolCallIDs: Map<string, number>
	progress: DelegationProgress
	notification: DelegationNotificationState
	retrieval: DelegationRetrievalState
	artifact: DelegationArtifactState
	error?: string
	title?: string
	description?: string
	result?: string
}

// Wall-clock budget default comes from harness.jsonc (0 = unlimited). The
// inactivity watchdog is the real safety net for hung generations.
const READ_POLL_INTERVAL_MS = 250
const ALL_COMPLETE_QUIET_PERIOD_MS = 50
const PARENT_NOTIFICATION_TIMEOUT_MS = 5_000
const INACTIVITY_SWEEP_INTERVAL_MS = 30_000
const AWAIT_RESULT_SETTLE_MS = 10_000
// Fallback when harness config is absent: how long a task lease may be held
// before the sweep presumes its tool call died without an after-hook.
const TASK_LEASE_STALE_FALLBACK_MS = 45 * 60 * 1000

interface DelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	options?: WorkflowDelegateOptions
}

interface DelegationListItem {
	id: string
	status: DelegationStatus
	title?: string
	description?: string
	agent?: string
	unread?: boolean
}

interface DelegationManagerOptions {
	maxRunTimeMs?: number
	readPollIntervalMs?: number
	allCompleteQuietPeriodMs?: number
	idGenerator?: () => string
	metadataGenerator?: typeof generateMetadata
	harness?: HarnessConfig
	scheduler?: TierScheduler
	resolver?: TierResolver
}

// ==========================================
// LOGGING HELPER
// ==========================================

/**
 * Create a structured logger that sends messages to OpenCode's log API.
 * Catches errors silently to avoid disrupting tool execution.
 */
function createLogger(client: OpencodeClient) {
	const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
		client.app.log({ body: { service: "background-agents", level, message } }).catch(() => {})
	return {
		debug: (msg: string) => log("debug", msg),
		info: (msg: string) => log("info", msg),
		warn: (msg: string) => log("warn", msg),
		error: (msg: string) => log("error", msg),
	}
}

type Logger = ReturnType<typeof createLogger>

// ==========================================
// AGENT CAPABILITY DETECTION
// ==========================================

/**
 * Parse agent mode at boundary.
 * Returns trusted type indicating if agent is a sub-agent.
 */
async function parseAgentMode(
	client: OpencodeClient,
	agentName: string,
	log: Logger,
): Promise<{ isSubAgent: boolean }> {
	try {
		const result = await client.app.agents({})
		const agents = (result.data ?? []) as { name: string; mode?: string }[]
		const agent = agents.find((a) => a.name === agentName)
		return { isSubAgent: agent?.mode === "subagent" }
	} catch (error) {
		// Fail-safe: Agent list errors shouldn't block task calls
		// Fail-loud: Log for observability
		log.warn(
			`Agent list fetch failed for "${agentName}", assuming non-sub-agent: ${error instanceof Error ? error.message : String(error)}`,
		)
		return { isSubAgent: false }
	}
}

/**
 * Permission entry type: simple value or pattern object.
 * Matches CLI schema: z.union([z.enum(["ask", "allow", "deny"]), z.record(z.enum(...))])
 */
type PermissionEntry = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">

/**
 * Check if a permission entry denies access (Law 4: Fail Fast).
 * Handles both simple values ("deny") and pattern objects ({ "*": "deny" }).
 */
function isPermissionDenied(entry: PermissionEntry | undefined): boolean {
	if (entry === undefined) return false
	if (entry === "deny") return true
	if (typeof entry === "object" && entry["*"] === "deny") return true
	return false
}

/**
 * Parse agent write capability at boundary.
 * Returns trusted type indicating if agent is read-only.
 *
 * An agent is read-only when ALL of: edit, write, and bash are denied.
 * Permission schema supports both simple ("deny") and pattern ({ "*": "deny" }) values.
 */
async function parseAgentWriteCapability(
	client: OpencodeClient,
	agentName: string,
	log: Logger,
): Promise<{ isReadOnly: boolean }> {
	try {
		const config = await client.config.get()
		const configData = config.data as {
			agent?: Record<
				string,
				{
					permission?: Record<string, PermissionEntry>
				}
			>
		}
		const permission = configData?.agent?.[agentName]?.permission ?? {}

		const editDenied = isPermissionDenied(permission.edit)
		const writeDenied = isPermissionDenied(permission.write)
		const bashDenied = isPermissionDenied(permission.bash)

		return { isReadOnly: editDenied && writeDenied && bashDenied }
	} catch (error) {
		// Fail-safe: Config errors shouldn't block task calls
		// Fail-loud: Log for observability
		log.warn(
			`Config fetch failed for "${agentName}", assuming write-capable: ${error instanceof Error ? error.message : String(error)}`,
		)
		return { isReadOnly: false }
	}
}

/**
 * DELEGATION MANAGER
 */
function isTerminalStatus(status: DelegationStatus): status is DelegationTerminalStatus {
	return (
		status === "complete" || status === "error" || status === "cancelled" || status === "timeout"
	)
}

function isActiveStatus(status: DelegationStatus): boolean {
	return status === "registered" || status === "queued" || status === "running"
}

function normalizeId(value: string): string {
	// Plan citations use "ref:<id>"; accept both forms everywhere IDs are read.
	return value.trim().replace(/^ref:/, "")
}

function parsePersistedStatus(raw: string | undefined): DelegationStatus {
	if (!raw) return "complete"
	if (raw === "registered") return "registered"
	if (raw === "queued") return "queued"
	if (raw === "running") return "running"
	if (raw === "complete") return "complete"
	if (raw === "error") return "error"
	if (raw === "cancelled") return "cancelled"
	if (raw === "timeout") return "timeout"
	return "complete"
}

class DelegationManager {
	private delegations: Map<string, DelegationRecord> = new Map()
	private delegationsBySession: Map<string, string> = new Map()
	private terminalWaiters: Map<string, { promise: Promise<void>; resolve: () => void }> = new Map()
	private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private client: OpencodeClient
	private baseDir: string
	private log: Logger
	private maxRunTimeMs: number
	private readPollIntervalMs: number
	private allCompleteQuietPeriodMs: number
	private idGenerator: () => string
	private metadataGenerator: typeof generateMetadata
	private pendingByParent: Map<string, Set<string>> = new Map()
	private parentNotificationState: Map<string, ParentNotificationState> = new Map()
	private pendingNotifications: Map<string, string[]> = new Map()
	private harness: HarnessConfig
	private scheduler?: TierScheduler
	private resolver?: TierResolver
	private leases: Map<string, Lease> = new Map()
	private queueAborts: Map<string, AbortController> = new Map()
	private inactivityTimer?: ReturnType<typeof setInterval>

	constructor(
		client: OpencodeClient,
		baseDir: string,
		log: Logger,
		options: DelegationManagerOptions = {},
	) {
		this.client = client
		this.baseDir = baseDir
		this.log = log
		this.harness = options.harness ?? HARNESS_DEFAULTS
		this.scheduler = options.scheduler
		this.resolver = options.resolver
		this.maxRunTimeMs = options.maxRunTimeMs ?? this.harness.timeouts.dispatchBudgetMs
		this.readPollIntervalMs = options.readPollIntervalMs ?? READ_POLL_INTERVAL_MS
		this.allCompleteQuietPeriodMs = options.allCompleteQuietPeriodMs ?? ALL_COMPLETE_QUIET_PERIOD_MS
		this.idGenerator = options.idGenerator ?? generateReadableId
		this.metadataGenerator = options.metadataGenerator ?? generateMetadata
	}

	/**
	 * Resolves the root session ID by walking up the parent chain.
	 */
	async getRootSessionID(sessionID: string): Promise<string> {
		let currentID = sessionID
		// Prevent infinite loops with max depth
		for (let depth = 0; depth < 10; depth++) {
			try {
				const session = await this.client.session.get({
					path: { id: currentID },
				})

				if (!session.data?.parentID) {
					return currentID
				}

				currentID = session.data.parentID
			} catch {
				// If we can't fetch the session, assume current is root or best effort
				return currentID
			}
		}
		return currentID
	}

	/**
	 * Get the delegations directory for a session scope (root session)
	 */
	private async getDelegationsDir(sessionID: string): Promise<string> {
		const rootID = await this.getRootSessionID(sessionID)
		return path.join(this.baseDir, rootID)
	}

	/**
	 * Ensure the delegations directory exists
	 */
	private async ensureDelegationsDir(sessionID: string): Promise<string> {
		const dir = await this.getDelegationsDir(sessionID)
		await fs.mkdir(dir, { recursive: true })
		return dir
	}

	private createTerminalWaiter(id: string): void {
		if (this.terminalWaiters.has(id)) return

		let resolve: (() => void) | undefined
		const promise = new Promise<void>((innerResolve) => {
			resolve = innerResolve
		})

		if (!resolve) {
			throw new Error(`Failed to initialize terminal waiter for delegation ${id}`)
		}

		this.terminalWaiters.set(id, { promise, resolve })
	}

	private resolveTerminalWaiter(id: string): void {
		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return
		waiter.resolve()
	}

	private clearTimeoutTimer(id: string): void {
		const timer = this.timeoutTimers.get(id)
		if (!timer) return
		clearTimeout(timer)
		this.timeoutTimers.delete(id)
	}

	private scheduleTimeout(id: string): void {
		this.clearTimeoutTimer(id)
		// 0 means unlimited wall clock; the inactivity watchdog covers hangs.
		if (this.maxRunTimeMs <= 0) return
		const timer = setTimeout(() => {
			void this.handleTimeout(id)
		}, this.maxRunTimeMs + 5_000)
		this.timeoutTimers.set(id, timer)
	}

	private updateDelegation(
		id: string,
		mutate: (delegation: DelegationRecord, now: Date) => void,
	): DelegationRecord | undefined {
		const delegation = this.delegations.get(id)
		if (!delegation) return undefined

		const now = new Date()
		mutate(delegation, now)
		delegation.updatedAt = now
		return delegation
	}

	private registerDelegation(input: {
		id: string
		rootSessionID: string
		sessionID: string
		parentSessionID: string
		parentMessageID: string
		parentAgent: string
		prompt: string
		agent: string
		artifactPath: string
		tier: string | null
		modelOverride?: string
		silent: boolean
	}): DelegationRecord {
		if (!input.silent && !this.pendingByParent.has(input.parentSessionID)) {
			this.pendingByParent.set(input.parentSessionID, new Set())
			this.resetParentAllCompleteNotificationCycle(input.parentSessionID)
		}

		const parentNotificationState = this.getParentNotificationState(input.parentSessionID)
		const notificationCycle = parentNotificationState.allCompleteCycle
		const notificationCycleToken = parentNotificationState.allCompleteCycleToken

		const now = new Date()
		const delegation: DelegationRecord = {
			id: input.id,
			rootSessionID: input.rootSessionID,
			sessionID: input.sessionID,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			tier: input.tier,
			modelOverride: input.modelOverride,
			silent: input.silent,
			notificationCycle,
			notificationCycleToken,
			status: "registered",
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
			activeToolCallIDs: new Map(),
			progress: {
				toolCalls: 0,
				lastUpdateAt: now,
				lastHeartbeatAt: now,
			},
			notification: {
				terminalNotificationCount: 0,
			},
			retrieval: {
				retrievalCount: 0,
			},
			artifact: {
				filePath: input.artifactPath,
			},
		}

		this.delegations.set(delegation.id, delegation)
		this.delegationsBySession.set(delegation.sessionID, delegation.id)
		this.createTerminalWaiter(delegation.id)
		if (!input.silent) {
			this.pendingByParent.get(delegation.parentSessionID)?.add(delegation.id)
		}

		return delegation
	}

	private markStarted(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			delegation.status = "running"
			delegation.startedAt = now
			delegation.lastActivityAt = now
			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now
		})
	}

	private markProgress(id: string, messageText?: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			if (delegation.status === "registered" || delegation.status === "queued") {
				delegation.status = "running"
				delegation.startedAt = delegation.startedAt ?? now
			}

			delegation.lastActivityAt = now
			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now

			if (messageText) {
				delegation.progress.lastMessage = messageText
				delegation.progress.lastMessageAt = now
			}
		})
	}

	private markTerminal(
		id: string,
		status: DelegationTerminalStatus,
		error?: string,
	): { transitioned: boolean; delegation?: DelegationRecord } {
		const delegation = this.delegations.get(id)
		if (!delegation) return { transitioned: false }

		if (isTerminalStatus(delegation.status)) {
			return { transitioned: false, delegation }
		}

		const now = new Date()
		delegation.status = status
		delegation.completedAt = now
		delegation.updatedAt = now
		if (error) {
			delegation.error = error
		}

		const pending = this.pendingByParent.get(delegation.parentSessionID)
		if (pending) {
			pending.delete(delegation.id)
			if (pending.size === 0) {
				this.pendingByParent.delete(delegation.parentSessionID)
			}
		}

		// Single release point for scheduler resources: every terminal path
		// (complete, error, timeout, cancel) funnels through this once-only
		// transition, so slots can never leak or double-free.
		const lease = this.leases.get(id)
		if (lease) {
			this.leases.delete(id)
			void lease.release()
		}
		const queueAbort = this.queueAborts.get(id)
		if (queueAbort) {
			this.queueAborts.delete(id)
			queueAbort.abort()
		}
		delegation.activeToolCallIDs.clear()

		this.clearTimeoutTimer(id)
		this.resolveTerminalWaiter(id)

		return { transitioned: true, delegation }
	}

	private markNotified(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			delegation.notification.terminalNotifiedAt = now
			delegation.notification.terminalNotificationCount += 1
		})
	}

	private getParentNotificationState(parentSessionID: string): ParentNotificationState {
		const existing = this.parentNotificationState.get(parentSessionID)
		if (existing) return existing

		const initialized: ParentNotificationState = {
			allCompleteNotificationCount: 0,
			allCompleteCycle: 0,
			allCompleteCycleToken: this.buildAllCompleteCycleToken(parentSessionID, 0),
		}
		this.parentNotificationState.set(parentSessionID, initialized)
		return initialized
	}

	private buildAllCompleteCycleToken(parentSessionID: string, cycle: number): string {
		return `${parentSessionID}:${cycle}`
	}

	private resetParentAllCompleteNotificationCycle(parentSessionID: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		this.cancelScheduledAllComplete(state)
		state.allCompleteCycle += 1
		state.allCompleteCycleToken = this.buildAllCompleteCycleToken(
			parentSessionID,
			state.allCompleteCycle,
		)
		state.allCompleteNotifiedAt = undefined
		state.allCompleteNotifiedCycle = undefined
		state.allCompleteNotifiedCycleToken = undefined
	}

	private cancelScheduledAllComplete(state: ParentNotificationState): void {
		if (state.allCompleteScheduledTimer) {
			clearTimeout(state.allCompleteScheduledTimer)
		}
		state.allCompleteScheduledTimer = undefined
		state.allCompleteScheduledCycle = undefined
		state.allCompleteScheduledCycleToken = undefined
	}

	private areCycleTerminalNotificationsComplete(
		parentSessionID: string,
		cycleToken: string,
	): boolean {
		let cycleDelegationCount = 0

		for (const delegation of this.delegations.values()) {
			if (delegation.parentSessionID !== parentSessionID) continue
			if (delegation.notificationCycleToken !== cycleToken) continue
			// Silent (workflow) delegations never emit terminal notifications, so
			// counting them here would block the all-complete signal forever.
			if (delegation.silent) continue

			cycleDelegationCount += 1
			if (!delegation.notification.terminalNotifiedAt) {
				return false
			}
		}

		return cycleDelegationCount > 0
	}

	private scheduleAllCompleteForParent(parentSessionID: string, parentAgent: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		const cycle = state.allCompleteCycle
		const cycleToken = state.allCompleteCycleToken
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		if (state.allCompleteNotifiedCycleToken === cycleToken) return
		if (state.allCompleteScheduledCycleToken === cycleToken) return

		this.cancelScheduledAllComplete(state)

		state.allCompleteScheduledCycle = cycle
		state.allCompleteScheduledCycleToken = cycleToken
		state.allCompleteScheduledTimer = setTimeout(() => {
			void this.dispatchScheduledAllComplete(parentSessionID, parentAgent, cycle, cycleToken)
		}, this.allCompleteQuietPeriodMs)
	}

	private async dispatchScheduledAllComplete(
		parentSessionID: string,
		parentAgent: string,
		cycle: number,
		cycleToken: string,
	): Promise<void> {
		const state = this.getParentNotificationState(parentSessionID)

		if (state.allCompleteScheduledCycleToken !== cycleToken) return

		this.cancelScheduledAllComplete(state)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return
		if (state.allCompleteNotifiedCycleToken === cycleToken) return

		const deliveryStatus = await this.sendParentNotification(
			parentSessionID,
			parentAgent,
			this.buildAllCompleteNotification(parentSessionID, cycle, cycleToken),
			false,
		)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		state.allCompleteNotifiedAt = new Date()
		state.allCompleteNotificationCount += 1
		state.allCompleteNotifiedCycle = cycle
		state.allCompleteNotifiedCycleToken = cycleToken

		await this.debugLog(
			`all-complete notification ${deliveryStatus} for ${parentSessionID} cycle=${cycleToken}`,
		)
	}

	private queuePendingNotification(parentSessionID: string, notification: string): void {
		const pending = this.pendingNotifications.get(parentSessionID) ?? []
		pending.push(notification)
		this.pendingNotifications.set(parentSessionID, pending)
	}

	private async sendParentNotification(
		parentSessionID: string,
		parentAgent: string,
		notification: string,
		noReply: boolean,
	): Promise<"sent" | "queued" | "timed-out"> {
		const session = this.client.session
		let timeout: ReturnType<typeof setTimeout> | undefined

		try {
			await this.debugLog(
				`parent notification sending for ${parentSessionID} noReply=${noReply} async=${Boolean(
					session.promptAsync,
				)}`,
			)

			const result = await Promise.race<"sent" | "timed-out">([
				session
					.promptAsync({
						path: { id: parentSessionID },
						body: {
							noReply,
							agent: parentAgent,
							parts: [{ type: "text", text: notification }],
						},
					})
					.then(() => "sent" as const),
				new Promise<"timed-out">((resolve) => {
					timeout = setTimeout(() => resolve("timed-out"), PARENT_NOTIFICATION_TIMEOUT_MS)
				}),
			])

			if (result === "timed-out") {
				await this.debugLog(
					`parent notification timed out for ${parentSessionID} after ${PARENT_NOTIFICATION_TIMEOUT_MS}ms`,
				)
			}

			return result
		} catch (error) {
			this.queuePendingNotification(parentSessionID, notification)
			await this.debugLog(
				`parent notification queued for ${parentSessionID}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			)
			return "queued"
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}

	injectPendingNotificationsIntoChatMessage(
		output: { parts?: Array<{ type: string; text?: string }> },
		sessionID: string,
	): void {
		const pending = this.pendingNotifications.get(sessionID)
		if (!pending || pending.length === 0) return

		this.pendingNotifications.delete(sessionID)
		const notificationText = pending.join("\n\n")
		const parts = output.parts ?? []
		const firstTextPart = parts.find((part) => part.type === "text")

		if (firstTextPart) {
			firstTextPart.text = `${notificationText}\n\n${firstTextPart.text ?? ""}`
			output.parts = parts
			return
		}

		output.parts = [{ type: "text", text: notificationText }, ...parts]
	}

	private markRetrieved(id: string, readerSessionID: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			delegation.retrieval.retrievedAt = now
			delegation.retrieval.retrievalCount += 1
			delegation.retrieval.lastReaderSessionID = readerSessionID
		})
	}

	private hasUnreadCompletion(delegation: DelegationRecord): boolean {
		if (!isTerminalStatus(delegation.status)) return false
		if (!delegation.notification.terminalNotifiedAt) return false
		if (!delegation.completedAt) return false

		if (!delegation.retrieval.retrievedAt) return true
		return delegation.retrieval.retrievedAt.getTime() < delegation.completedAt.getTime()
	}

	private async waitForTerminal(id: string, timeoutMs: number): Promise<"terminal" | "timeout"> {
		const delegation = this.delegations.get(id)
		if (!delegation) return "timeout"
		if (isTerminalStatus(delegation.status)) return "terminal"

		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return "timeout"

		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race<"terminal" | "timeout">([
				waiter.promise.then(() => "terminal"),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs)
				}),
			])
			return result
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private async generateUniqueDelegationId(artifactDir: string): Promise<string> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const candidate = this.idGenerator()
			if (this.delegations.has(candidate)) continue

			const candidatePath = path.join(artifactDir, `${candidate}.md`)
			try {
				await fs.access(candidatePath)
			} catch {
				return candidate
			}
		}

		throw new Error("Failed to generate unique delegation ID after 20 attempts")
	}

	private getDelegationBySession(sessionID: string): DelegationRecord | undefined {
		const delegationId = this.delegationsBySession.get(sessionID)
		if (!delegationId) return undefined
		return this.delegations.get(delegationId)
	}

	private isVisibleToSession(delegation: DelegationRecord, rootSessionID: string): boolean {
		return delegation.rootSessionID === rootSessionID
	}

	private buildTerminalNotification(delegation: DelegationRecord, remainingCount: number): string {
		const lines = [
			"<task-notification>",
			`<task-id>${delegation.id}</task-id>`,
			`<status>${delegation.status}</status>`,
			`<summary>Background agent ${delegation.status}: ${delegation.title || delegation.id}</summary>`,
			delegation.title ? `<title>${delegation.title}</title>` : "",
			delegation.description ? `<description>${delegation.description}</description>` : "",
			delegation.error ? `<error>${delegation.error}</error>` : "",
			`<artifact>${delegation.artifact.filePath}</artifact>`,
			`<retrieval>Use delegation_read("${delegation.id}") for full output.</retrieval>`,
			remainingCount > 0 ? `<remaining>${remainingCount}</remaining>` : "",
			"</task-notification>",
		]

		return lines.filter((line) => line.length > 0).join("\n")
	}

	private buildAllCompleteNotification(
		parentSessionID: string,
		cycle: number,
		cycleToken: string,
	): string {
		// cycle-token is a boundary watermark.
		// Receivers should ignore all-complete payloads whose token is older than
		// the latest known registration cycle for this parent session.
		return [
			"<task-notification>",
			"<type>all-complete</type>",
			"<status>completed</status>",
			"<summary>All delegations complete.</summary>",
			`<parent-session-id>${parentSessionID}</parent-session-id>`,
			`<cycle>${cycle}</cycle>`,
			`<cycle-token>${cycleToken}</cycle-token>`,
			"</task-notification>",
		].join("\n")
	}

	private buildDeterministicTerminalReadResponse(delegation: DelegationRecord): string {
		const lines = [
			`Delegation ID: ${delegation.id}`,
			`Status: ${delegation.status}`,
			`Agent: ${delegation.agent}`,
			`Started: ${delegation.startedAt?.toISOString() || delegation.createdAt.toISOString()}`,
			`Completed: ${delegation.completedAt?.toISOString() || "N/A"}`,
			`Artifact: ${delegation.artifact.filePath}`,
		]

		if (delegation.title) lines.push(`Title: ${delegation.title}`)
		if (delegation.description) lines.push(`Description: ${delegation.description}`)
		if (delegation.error) lines.push(`Error: ${delegation.error}`)

		lines.push(`\nUse delegation_read("${delegation.id}") again after persistence completes.`)
		return lines.join("\n")
	}

	private async readPersistedArtifact(filePath: string): Promise<string | null> {
		try {
			return await fs.readFile(filePath, "utf8")
		} catch {
			return null
		}
	}

	private async waitForPersistedArtifact(
		filePath: string,
		maxWaitMs: number,
	): Promise<string | null> {
		const start = Date.now()
		while (Date.now() - start < maxWaitMs) {
			const content = await this.readPersistedArtifact(filePath)
			if (content !== null) return content
			await new Promise((resolve) => setTimeout(resolve, this.readPollIntervalMs))
		}

		return null
	}

	private async resolveDelegationResult(delegation: DelegationRecord): Promise<string> {
		if (delegation.status === "error") {
			return `Error: ${delegation.error || "Delegation failed."}`
		}

		if (delegation.status === "cancelled") {
			const partial = await this.getResult(delegation)
			return `${partial}\n\n[CANCELLED]`
		}

		if (delegation.status === "timeout") {
			const partial = await this.getResult(delegation)
			return `${partial}\n\n[TIMEOUT REACHED]`
		}

		return await this.getResult(delegation)
	}

	private async finalizeDelegation(
		delegationId: string,
		status: DelegationTerminalStatus,
		error?: string,
	): Promise<void> {
		const { transitioned, delegation } = this.markTerminal(delegationId, status, error)
		if (!transitioned || !delegation) return

		await this.debugLog(`finalizeDelegation(${delegation.id}, ${status}) started`)

		const resolvedResult = await this.resolveDelegationResult(delegation)
		delegation.result = resolvedResult

		if (resolvedResult.trim().length > 0) {
			// Truncation is the default: no extra LLM round-trip per delegation.
			const metadata =
				!delegation.silent && this.harness.metadata.useLlm
					? await this.metadataGenerator(this.client, resolvedResult, delegation.sessionID, (msg) =>
							this.debugLog(msg),
						)
					: truncationMetadata(resolvedResult)
			delegation.title = metadata.title
			delegation.description = metadata.description
		}

		await this.persistOutput(delegation, resolvedResult)
		if (!delegation.silent) {
			await this.notifyParent(delegation.id)
		}
	}

	private async notifyParent(delegationId: string): Promise<void> {
		try {
			const delegation = this.delegations.get(delegationId)
			if (!delegation) return
			if (!isTerminalStatus(delegation.status)) return
			if (delegation.notification.terminalNotifiedAt) {
				await this.debugLog(`notifyParent skipped for ${delegation.id}; already notified`)
				return
			}

			const remainingCount = this.getPendingCount(delegation.parentSessionID)
			const terminalNotification = this.buildTerminalNotification(delegation, remainingCount)

			const deliveryStatus = await this.sendParentNotification(
				delegation.parentSessionID,
				delegation.parentAgent,
				terminalNotification,
				true,
			)

			this.markNotified(delegation.id)
			this.scheduleAllCompleteForParent(delegation.parentSessionID, delegation.parentAgent)

			await this.debugLog(
				`notifyParent ${deliveryStatus} for ${delegation.id} (remaining=${remainingCount}, status=${delegation.status})`,
			)
		} catch (error) {
			await this.debugLog(
				`notifyParent failed for ${delegationId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Delegate a task to an agent
	 */
	async delegate(input: DelegateInput): Promise<DelegationRecord> {
		// Validate agent exists before creating session
		const agentsResult = await this.client.app.agents({})
		const agents = (agentsResult.data ?? []) as {
			name: string
			description?: string
			mode?: string
		}[]
		const validAgent = agents.find((a) => a.name === input.agent)

		if (!validAgent) {
			const available = agents
				.filter((a) => a.mode === "subagent" || a.mode === "all" || !a.mode)
				.map((a) => `• ${a.name}${a.description ? ` - ${a.description}` : ""}`)
				.join("\n")

			throw new Error(
				`Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`,
			)
		}

		// Check if agent is read-only (Early Exit + Fail Fast).
		// Workflow-originated delegations may bypass this: the workflow runtime is
		// responsible for the parallelism, and its agents still queue for slots.
		if (!input.options?.skipReadOnlyGuard) {
			const { isReadOnly } = await parseAgentWriteCapability(this.client, input.agent, this.log)
			if (!isReadOnly) {
				throw new Error(
					`Agent "${input.agent}" is write-capable and requires the native \`task\` tool for proper undo/branching support.\n\n` +
						`Use \`task\` instead of \`delegate\` for write-capable agents.\n\n` +
						`Read-only sub-agents (edit/write/bash denied) use \`delegate\`.\n` +
						`Write-capable sub-agents (any write permission) use \`task\`.`,
				)
			}
		}

		// Resolve the scheduler tier (and validate any model override) up front so
		// bad input fails before a session is created.
		let tier: string | null = null
		if (input.options?.model && !splitModelRef(input.options.model)) {
			throw new Error(
				`Invalid model override "${input.options.model}". Use "provider/model" form, e.g. "lmstudio/qwen/qwen3.6-27b".`,
			)
		}
		if (this.resolver) {
			const resolved = await this.resolver.resolveAgentTier(input.agent, input.options?.model)
			tier = resolved.tier
		}

		const artifactDir = await this.ensureDelegationsDir(input.parentSessionID)
		const rootSessionID = await this.getRootSessionID(input.parentSessionID)
		const stableId = await this.generateUniqueDelegationId(artifactDir)
		const artifactPath = path.join(artifactDir, `${stableId}.md`)

		await this.debugLog(`delegate() called, generated stable ID: ${stableId}`)

		// Create isolated session for delegation
		const sessionResult = await this.client.session.create({
			body: {
				title: `Delegation: ${stableId}`,
				parentID: input.parentSessionID,
			},
		})

		await this.debugLog(`session.create result: ${JSON.stringify(sessionResult.data)}`)

		if (!sessionResult.data?.id) {
			throw new Error("Failed to create delegation session")
		}

		const delegation = this.registerDelegation({
			id: stableId,
			rootSessionID,
			sessionID: sessionResult.data.id,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			artifactPath,
			tier,
			modelOverride: input.options?.model,
			silent: input.options?.silent ?? false,
		})

		await this.debugLog(
			`Registered delegation ${delegation.id} (tier=${tier ?? "uncapped"}, silent=${delegation.silent})`,
		)

		if (!tier || !this.scheduler) {
			void this.dispatch(delegation.id, undefined)
			return delegation
		}

		// Queue for a tier slot; dispatch fires when one frees. The delegation is
		// visible (and cancellable) the whole time it waits.
		const controller = new AbortController()
		this.queueAborts.set(delegation.id, controller)
		this.scheduler
			.acquire(tier, {
				kind: delegation.silent ? "workflow" : "delegate",
				agent: input.agent,
				sessionID: delegation.sessionID,
				jobId: delegation.id,
				signal: controller.signal,
				maxWaitMs: this.harness.timeouts.queueWaitMs,
				onQueued: (position) => {
					this.updateDelegation(delegation.id, (record) => {
						if (record.status !== "registered") return
						record.status = "queued"
						record.queuePosition = position
					})
				},
			})
			.then((lease) => {
				this.queueAborts.delete(delegation.id)
				void this.dispatch(delegation.id, lease)
			})
			.catch((error: unknown) => {
				this.queueAborts.delete(delegation.id)
				// Aborted acquires happen when the delegation was cancelled or
				// finalized while queued; that path already settled the record.
				if (error instanceof AcquireAbortedError) return
				void this.finalizeDelegation(
					delegation.id,
					"error",
					error instanceof QueueWaitTimeoutError
						? `${error.message}. Check agents_status() for tier occupancy.`
						: error instanceof Error
							? error.message
							: String(error),
				)
			})

		return delegation
	}

	/**
	 * Start a delegation's agent loop. Called immediately for uncapped tiers or
	 * once a scheduler slot has been acquired. The wall-clock budget (if any) is
	 * armed HERE, not at enqueue, so queued time never counts against the run.
	 */
	private async dispatch(id: string, lease: Lease | undefined): Promise<void> {
		const delegation = this.delegations.get(id)
		if (!delegation || isTerminalStatus(delegation.status)) {
			if (lease) await lease.release()
			return
		}
		if (lease) this.leases.set(id, lease)

		this.updateDelegation(id, (record, now) => {
			record.dispatchedAt = now
			record.lastActivityAt = now
			record.queuePosition = undefined
			if (this.maxRunTimeMs > 0) {
				record.timeoutAt = new Date(now.getTime() + this.maxRunTimeMs)
			}
		})
		this.scheduleTimeout(id)
		this.markStarted(id)

		const modelRef = delegation.modelOverride ? splitModelRef(delegation.modelOverride) : undefined

		// Fire the prompt (using prompt() instead of promptAsync() to properly initialize agent loop)
		// Agent param is critical for MCP tools - tells OpenCode which agent's config to use
		// Anti-recursion: disable nested delegations and state-modifying tools via tools config
		this.client.session
			.prompt({
				path: { id: delegation.sessionID },
				body: {
					agent: delegation.agent,
					...(modelRef ? { model: modelRef } : {}),
					parts: [{ type: "text", text: delegation.prompt }],
					tools: {
						task: false,
						delegate: false,
						delegation_cancel: false,
						todowrite: false,
						plan_save: false,
						workflow: false,
						workflow_status: false,
					},
				},
			})
			.then(() => {
				void this.finalizeDelegation(delegation.id, "complete")
			})
			.catch((error: Error) => {
				void this.finalizeDelegation(delegation.id, "error", error.message)
			})
	}

	/**
	 * Handle delegation wall-clock timeout (only armed when dispatchBudgetMs > 0).
	 * Aborts the session instead of deleting it so partial output survives.
	 */
	private async handleTimeout(delegationId: string): Promise<void> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleTimeout for delegation ${delegation.id}`)

		delegation.pendingTerminalStatus = "timeout"
		try {
			await this.client.session.abort({
				path: { id: delegation.sessionID },
			})
		} catch {
			// Ignore
		}

		await this.finalizeDelegation(
			delegation.id,
			"timeout",
			`Delegation exceeded its ${Math.round(this.maxRunTimeMs / 1000)}s wall-clock budget`,
		)
	}

	/**
	 * Inactivity watchdog: the only default kill switch. A running delegation is
	 * stalled when the model has streamed nothing AND no tool call is in flight
	 * for timeouts.inactivityMs. A subagent running a 40-minute build never
	 * trips this; a hung generation does, freeing its tier slot for the queue.
	 */
	startInactivityWatchdog(): void {
		if (this.inactivityTimer) return
		if (this.harness.timeouts.inactivityMs <= 0) return
		this.inactivityTimer = setInterval(() => {
			void this.sweepStalledDelegations()
		}, INACTIVITY_SWEEP_INTERVAL_MS)
		this.inactivityTimer.unref?.()
	}

	stopInactivityWatchdog(): void {
		if (!this.inactivityTimer) return
		clearInterval(this.inactivityTimer)
		this.inactivityTimer = undefined
	}

	private async sweepStalledDelegations(): Promise<void> {
		const inactivityMs = this.harness.timeouts.inactivityMs
		if (inactivityMs <= 0) return
		const now = Date.now()

		for (const delegation of this.delegations.values()) {
			if (delegation.status !== "running") continue

			// opencode does not fire tool.execute.after for tools that error, and
			// remote MCP calls can hang forever. Purge entries past the deference
			// cap so one dead tool call cannot disarm the watchdog indefinitely.
			const toolCallStaleMs = this.harness.timeouts.toolCallStaleMs
			if (toolCallStaleMs > 0) {
				for (const [callID, startedAtMs] of delegation.activeToolCallIDs) {
					if (now - startedAtMs > toolCallStaleMs) {
						delegation.activeToolCallIDs.delete(callID)
						await this.debugLog(
							`inactivity watchdog: presuming dead tool call ${callID} in ${delegation.id} (in flight ${Math.round((now - startedAtMs) / 60_000)}m)`,
						)
					}
				}
			}

			if (delegation.activeToolCallIDs.size > 0) continue
			if (now - delegation.lastActivityAt.getTime() <= inactivityMs) continue

			await this.debugLog(`inactivity watchdog: aborting stalled delegation ${delegation.id}`)
			delegation.pendingTerminalStatus = "timeout"
			try {
				await this.client.session.abort({ path: { id: delegation.sessionID } })
			} catch {
				// Ignore
			}
			await this.finalizeDelegation(
				delegation.id,
				"timeout",
				`Stalled: no model output or tool activity for ${Math.round(inactivityMs / 60_000)} minutes`,
			)
		}
	}

	/** Record streamed-output activity for a delegation's session. */
	recordActivity(sessionID: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return
		delegation.lastActivityAt = new Date()
	}

	/** Track tool calls in flight inside delegation sessions (watchdog input). */
	noteToolStart(sessionID: string, callID: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return
		delegation.activeToolCallIDs.set(callID, Date.now())
		delegation.lastActivityAt = new Date()
	}

	noteToolEnd(sessionID: string, callID: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation) return
		delegation.activeToolCallIDs.delete(callID)
		delegation.lastActivityAt = new Date()
	}

	/**
	 * Handle session.idle event - called when a session becomes idle.
	 * Only a RUNNING delegation may finalize here: queued delegations own idle
	 * (never-prompted) sessions, and finalizing those would report empty results.
	 */
	async handleSessionIdle(sessionID: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return
		if (delegation.status !== "running") {
			await this.debugLog(
				`handleSessionIdle ignored for ${delegation.id} (status=${delegation.status})`,
			)
			return
		}

		// session.abort emits an idle event; when a cancel/timeout initiator is
		// mid-finalize, do not race it into a bogus "complete".
		if (delegation.pendingTerminalStatus) {
			await this.debugLog(
				`handleSessionIdle deferring to pending ${delegation.pendingTerminalStatus} for ${delegation.id}`,
			)
			return
		}

		await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`)
		await this.finalizeDelegation(delegation.id, "complete")
	}

	/**
	 * Get the result from a delegation's session
	 */
	private async getResult(delegation: DelegationRecord): Promise<string> {
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messages.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				await this.debugLog(`getResult: No messages found for session ${delegation.sessionID}`)
				return `Delegation "${delegation.id}" completed but produced no output.`
			}

			await this.debugLog(
				`getResult: Found ${messageData.length} messages. Roles: ${messageData.map((m) => m.info.role).join(", ")}`,
			)

			// Find the last message from the assistant/model
			const isAssistantMessage = (m: SessionMessageItem): m is AssistantSessionMessageItem =>
				m.info.role === "assistant"

			const assistantMessages = messageData.filter(isAssistantMessage)

			if (assistantMessages.length === 0) {
				await this.debugLog(
					`getResult: No assistant messages found in ${JSON.stringify(messageData.map((m) => ({ role: m.info.role, keys: Object.keys(m) })))}`,
				)
				return `Delegation "${delegation.id}" completed but produced no assistant response.`
			}

			const isTextPart = (p: Part): p is TextPart => p.type === "text"
			const extractText = (message: AssistantSessionMessageItem): string | null => {
				const textParts = message.parts.filter(isTextPart)
				if (textParts.length === 0) return null
				return textParts.map((p) => p.text).join("\n")
			}

			const lastMessage = assistantMessages[assistantMessages.length - 1]
			const lastText = extractText(lastMessage)
			if (lastText !== null) return lastText

			// Reasoning models sometimes end on a reasoning-only message; walk back
			// to the most recent assistant message that produced real text.
			for (let i = assistantMessages.length - 2; i >= 0; i--) {
				const text = extractText(assistantMessages[i])
				if (text !== null) {
					await this.debugLog(
						`getResult: final message had no text parts; using assistant message ${i} of ${assistantMessages.length}`,
					)
					return text
				}
			}

			// Last resort: surface the reasoning trace instead of dropping output.
			const isReasoningPart = (p: Part): p is ReasoningPart => p.type === "reasoning"
			const reasoningText = lastMessage.parts
				.filter(isReasoningPart)
				.map((p) => p.text)
				.filter((text) => text.trim().length > 0)
				.join("\n")
			if (reasoningText.trim().length > 0) {
				await this.debugLog(`getResult: no text parts anywhere; returning reasoning trace`)
				return `[No final text was produced; showing the agent's reasoning trace]\n\n${reasoningText}`
			}

			await this.debugLog(
				`getResult: No text parts found in message: ${JSON.stringify(lastMessage)}`,
			)
			return `Delegation "${delegation.id}" completed but produced no text content.`
		} catch (error) {
			await this.debugLog(
				`getResult error: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return `Delegation "${delegation.id}" completed but result could not be retrieved: ${
				error instanceof Error ? error.message : "Unknown error"
			}`
		}
	}

	/**
	 * Persist delegation output to storage
	 */
	private async persistOutput(delegation: DelegationRecord, content: string): Promise<void> {
		try {
			// Use title/description if available (generated by small model), otherwise fallback
			const title = delegation.title || delegation.id
			const description = delegation.description || "(No description generated)"

			const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Session:** ${delegation.sessionID}
**Started:** ${(delegation.startedAt || delegation.createdAt).toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}

---

`
			await fs.writeFile(delegation.artifact.filePath, header + content, "utf8")

			const stats = await fs.stat(delegation.artifact.filePath)
			this.updateDelegation(delegation.id, (record, now) => {
				record.artifact.persistedAt = now
				record.artifact.byteLength = stats.size
				record.artifact.persistError = undefined
			})

			await this.debugLog(`Persisted output to ${delegation.artifact.filePath}`)
		} catch (error) {
			this.updateDelegation(delegation.id, (record) => {
				record.artifact.persistError =
					error instanceof Error ? error.message : "Unknown persistence error"
			})
			await this.debugLog(
				`Failed to persist output: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Read a delegation's output by ID. Blocks if the delegation is still running.
	 */
	async readOutput(sessionID: string, id: string): Promise<string> {
		const normalizedId = normalizeId(id)
		if (!normalizedId) {
			throw new Error("Delegation ID is required")
		}

		const rootSessionID = await this.getRootSessionID(sessionID)
		let delegation = this.delegations.get(normalizedId)
		if (delegation && !this.isVisibleToSession(delegation, rootSessionID)) {
			delegation = undefined
		}

		const fallbackFilePath = path.join(
			await this.getDelegationsDir(sessionID),
			`${normalizedId}.md`,
		)

		const immediateArtifactPath = delegation?.artifact.filePath || fallbackFilePath
		const immediateRead = await this.readPersistedArtifact(immediateArtifactPath)
		if (immediateRead !== null) {
			if (delegation) this.markRetrieved(delegation.id, sessionID)
			return immediateRead
		}

		if (!delegation) {
			throw new Error(
				`Delegation "${normalizedId}" not found.\n\nUse delegation_list() to see available delegations.`,
			)
		}

		if (isActiveStatus(delegation.status)) {
			// Bounded wait only: absorb the "read races completion" window, then
			// report status instead of blocking. Reads must never kill delegations.
			const waitMs = Math.max(this.harness.timeouts.readWaitMs, this.readPollIntervalMs)
			await this.debugLog(
				`readOutput: waiting up to ${waitMs}ms for delegation ${delegation.id} to reach terminal state`,
			)

			const waitResult = await this.waitForTerminal(delegation.id, waitMs)
			if (waitResult === "timeout" && isActiveStatus(delegation.status)) {
				return this.buildInFlightReadResponse(delegation)
			}
		}

		if (isTerminalStatus(delegation.status)) {
			const delayedPersisted = await this.waitForPersistedArtifact(
				delegation.artifact.filePath,
				Math.max(this.readPollIntervalMs * 8, 500),
			)
			if (delayedPersisted !== null) {
				this.markRetrieved(delegation.id, sessionID)
				return delayedPersisted
			}
		}

		const persisted = await this.readPersistedArtifact(delegation.artifact.filePath)
		if (persisted !== null) {
			this.markRetrieved(delegation.id, sessionID)
			return persisted
		}

		if (isTerminalStatus(delegation.status)) {
			return this.buildDeterministicTerminalReadResponse(delegation)
		}

		return `Delegation "${delegation.id}" is still running. You will receive a <task-notification> when it reaches a terminal state.`
	}

	private buildInFlightReadResponse(delegation: DelegationRecord): string {
		const lines: string[] = []
		if (delegation.status === "queued" || delegation.status === "registered") {
			lines.push(`Delegation "${delegation.id}" is queued (not yet dispatched).`)
			lines.push(
				`It is waiting for a "${delegation.tier ?? "unknown"}" tier slot${
					delegation.queuePosition ? ` (position ${delegation.queuePosition})` : ""
				} and will start automatically when one frees.`,
			)
		} else {
			lines.push(`Delegation "${delegation.id}" is still running.`)
			if (delegation.dispatchedAt) {
				lines.push(`Dispatched: ${delegation.dispatchedAt.toISOString()}`)
			}
			lines.push(`Last activity: ${delegation.lastActivityAt.toISOString()}`)
		}
		lines.push("You WILL be notified via <task-notification> when it completes. Do NOT poll.")
		lines.push(
			`To stop it: delegation_cancel("${delegation.id}"). For tier occupancy: agents_status().`,
		)
		return lines.join("\n")
	}

	/**
	 * Cancel a delegation on behalf of a session (visibility-checked tool path).
	 */
	async cancelDelegation(sessionID: string, id: string): Promise<string> {
		const normalizedId = normalizeId(id)
		if (!normalizedId) {
			throw new Error("Delegation ID is required")
		}

		const rootSessionID = await this.getRootSessionID(sessionID)
		const delegation = this.delegations.get(normalizedId)
		if (!delegation || !this.isVisibleToSession(delegation, rootSessionID)) {
			throw new Error(
				`Delegation "${normalizedId}" not found.\n\nUse delegation_list() to see available delegations.`,
			)
		}

		return await this.cancelDelegationInternal(delegation.id, "Cancelled by orchestrator request")
	}

	/**
	 * Cancel without a visibility check (workflow bridge and internal callers).
	 */
	async cancelDelegationInternal(id: string, reason: string): Promise<string> {
		const delegation = this.delegations.get(normalizeId(id))
		if (!delegation) {
			throw new Error(`Delegation "${id}" not found.`)
		}
		if (isTerminalStatus(delegation.status)) {
			return `Delegation "${delegation.id}" is already ${delegation.status}.`
		}

		const wasQueued = delegation.status !== "running"
		if (!wasQueued) {
			delegation.pendingTerminalStatus = "cancelled"
			try {
				await this.client.session.abort({ path: { id: delegation.sessionID } })
			} catch {
				// Session may already be idle
			}
		}

		await this.finalizeDelegation(delegation.id, "cancelled", reason)
		return wasQueued
			? `Delegation "${delegation.id}" cancelled while queued; its tier slot was never consumed.`
			: `Delegation "${delegation.id}" cancelled. Partial output (if any) was persisted to ${delegation.artifact.filePath}.`
	}

	/**
	 * Await a delegation's terminal state and resolved result text. Used by the
	 * workflow runtime; the optional signal cancels the delegation on abort.
	 */
	async awaitResult(id: string, opts: { signal?: AbortSignal } = {}): Promise<DelegationOutcome> {
		const delegation = this.delegations.get(normalizeId(id))
		if (!delegation) {
			return { id, status: "error", text: "", error: `Unknown delegation "${id}"`, durationMs: 0 }
		}
		const startMs = delegation.createdAt.getTime()

		if (!isTerminalStatus(delegation.status)) {
			if (opts.signal?.aborted) {
				await this.cancelDelegationInternal(delegation.id, "Cancelled by workflow abort").catch(
					() => {},
				)
			} else {
				const waiter = this.terminalWaiters.get(delegation.id)
				if (waiter) {
					let abortListener: (() => void) | undefined
					try {
						const raced = await Promise.race<"terminal" | "aborted">([
							waiter.promise.then(() => "terminal" as const),
							new Promise<"aborted">((resolve) => {
								if (!opts.signal) return
								abortListener = () => resolve("aborted")
								opts.signal.addEventListener("abort", abortListener, { once: true })
							}),
						])
						if (raced === "aborted") {
							await this.cancelDelegationInternal(
								delegation.id,
								"Cancelled by workflow abort",
							).catch(() => {})
							await this.waitForTerminal(delegation.id, AWAIT_RESULT_SETTLE_MS)
						}
					} finally {
						if (abortListener && opts.signal) {
							opts.signal.removeEventListener("abort", abortListener)
						}
					}
				}
			}
		}

		// finalizeDelegation resolves the terminal waiter before it computes the
		// result text; poll briefly until the result lands.
		const settleDeadline = Date.now() + AWAIT_RESULT_SETTLE_MS
		while (delegation.result === undefined && Date.now() < settleDeadline) {
			await new Promise((resolve) => setTimeout(resolve, this.readPollIntervalMs))
		}

		const status = isTerminalStatus(delegation.status) ? delegation.status : "error"
		return {
			id: delegation.id,
			status,
			text: delegation.result ?? "",
			error: delegation.error,
			durationMs: (delegation.completedAt?.getTime() ?? Date.now()) - startMs,
		}
	}

	getScheduler(): TierScheduler | undefined {
		return this.scheduler
	}

	getHarness(): HarnessConfig {
		return this.harness
	}

	/** Active (running or queued) delegations visible to a root session. */
	async describeActiveDelegations(sessionID: string): Promise<string[]> {
		const rootSessionID = await this.getRootSessionID(sessionID)
		const lines: string[] = []
		const now = Date.now()
		for (const delegation of this.delegations.values()) {
			if (!this.isVisibleToSession(delegation, rootSessionID)) continue
			if (!isActiveStatus(delegation.status)) continue
			const elapsed = Math.round((now - delegation.createdAt.getTime()) / 1000)
			const activity = Math.round((now - delegation.lastActivityAt.getTime()) / 1000)
			const state =
				delegation.status === "running"
					? `running ${elapsed}s, last activity ${activity}s ago`
					: `${delegation.status}${delegation.queuePosition ? ` (position ${delegation.queuePosition})` : ""}, waiting ${elapsed}s`
			lines.push(
				`- **${delegation.id}** (${delegation.agent}${delegation.modelOverride ? `, model ${delegation.modelOverride}` : ""}, tier ${delegation.tier ?? "uncapped"}): ${state}`,
			)
		}
		return lines
	}

	/**
	 * List all delegations for a session
	 */
	async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
		const rootSessionID = await this.getRootSessionID(sessionID)
		const results: DelegationListItem[] = []

		// Add in-memory delegations in this root session scope
		for (const delegation of this.delegations.values()) {
			if (!this.isVisibleToSession(delegation, rootSessionID)) continue

			results.push({
				id: delegation.id,
				status: delegation.status,
				title: delegation.title || delegation.id,
				description:
					delegation.description ||
					(delegation.status === "running" || delegation.status === "registered"
						? "(running)"
						: "(no description)"),
				agent: delegation.agent,
				unread: this.hasUnreadCompletion(delegation),
			})
		}

		// Check filesystem for persisted delegations
		try {
			const dir = await this.getDelegationsDir(rootSessionID)
			const files = await fs.readdir(dir)

			for (const file of files) {
				if (file.endsWith(".md")) {
					const id = file.replace(".md", "")
					// Deduplicate: prioritize in-memory status
					if (!results.find((r) => r.id === id)) {
						// Try to read title, agent, description from file
						let title = "(loaded from storage)"
						let description = ""
						let agent: string | undefined
						let status: DelegationStatus = "complete"
						try {
							const filePath = path.join(dir, file)
							const content = await fs.readFile(filePath, "utf8")
							const titleMatch = content.match(/^# (.+)$/m)
							if (titleMatch) title = titleMatch[1]
							const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m)
							if (agentMatch) agent = agentMatch[1]
							const statusMatch = content.match(/^\*\*Status:\*\* (.+)$/m)
							status = parsePersistedStatus(statusMatch?.[1]?.trim())
							// Get first paragraph after title as description
							const lines = content.split("\n")
							if (lines.length > 2 && lines[2]) {
								description = lines[2].slice(0, 150)
							}
						} catch {
							// Ignore read errors
						}
						results.push({
							id,
							status,
							title,
							description,
							agent,
							unread: false,
						})
					}
				}
			}
		} catch {
			// Directory may not exist yet
		}

		results.sort((a, b) => a.id.localeCompare(b.id))
		return results
	}

	/**
	 * Delete a delegation by id (cancels if running, removes from storage)
	 * Used internally for cleanup (timeout, etc.)
	 */
	async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
		const normalizedId = normalizeId(id)
		const delegation = this.delegations.get(normalizedId)

		if (delegation) {
			if (isActiveStatus(delegation.status)) {
				try {
					await this.client.session.delete({
						path: { id: delegation.sessionID },
					})
				} catch {
					// Session may already be deleted
				}
				this.markTerminal(delegation.id, "cancelled", "Delegation deleted by cleanup")
			}

			this.clearTimeoutTimer(delegation.id)
			this.terminalWaiters.delete(delegation.id)
			this.delegationsBySession.delete(delegation.sessionID)
			this.delegations.delete(delegation.id)
		}

		// Remove from filesystem
		try {
			const dir = await this.getDelegationsDir(sessionID)
			const filePath = path.join(dir, `${normalizedId}.md`)
			await fs.unlink(filePath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Find a delegation by its session ID
	 */
	findBySession(sessionID: string): DelegationRecord | undefined {
		return this.getDelegationBySession(sessionID)
	}

	/**
	 * Handle message events for progress tracking
	 */
	handleMessageEvent(sessionID: string, messageText?: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation) return
		this.markProgress(delegation.id, messageText)
	}

	/**
	 * Get count of pending delegations for a parent session
	 */
	getPendingCount(parentSessionID: string): number {
		const pendingSet = this.pendingByParent.get(parentSessionID)
		if (!pendingSet) return 0
		return Array.from(pendingSet).filter((id) => {
			const delegation = this.delegations.get(id)
			return delegation ? isActiveStatus(delegation.status) : false
		}).length
	}

	/**
	 * Get all currently running delegations (in-memory only)
	 */
	getRunningDelegations(rootSessionID?: string): DelegationRecord[] {
		return Array.from(this.delegations.values()).filter((delegation) => {
			if (rootSessionID && delegation.rootSessionID !== rootSessionID) return false
			return isActiveStatus(delegation.status)
		})
	}

	getUnreadCompletedDelegations(rootSessionID: string, limit = 10): DelegationRecord[] {
		return Array.from(this.delegations.values())
			.filter((delegation) => delegation.rootSessionID === rootSessionID)
			.filter((delegation) => this.hasUnreadCompletion(delegation))
			.sort((a, b) => {
				const aTime = a.completedAt?.getTime() || 0
				const bTime = b.completedAt?.getTime() || 0
				return bTime - aTime
			})
			.slice(0, limit)
	}

	/**
	 * Get recent completed delegations for compaction injection
	 */
	async getRecentCompletedDelegations(
		sessionID: string,
		limit: number = 10,
	): Promise<DelegationListItem[]> {
		const all = await this.listDelegations(sessionID)
		return all.filter((d) => isTerminalStatus(d.status)).slice(-limit)
	}

	/**
	 * Log debug messages
	 */
	async debugLog(msg: string): Promise<void> {
		// Only log if debug is enabled (could be env var or static const)
		// For now, mirroring previous behavior but writing to the new baseDir/debug.log
		const timestamp = new Date().toISOString()
		const line = `${timestamp}: ${msg}\n`
		const debugFile = path.join(this.baseDir, "background-agents-debug.log")

		try {
			await fs.appendFile(debugFile, line, "utf8")
		} catch {
			// Ignore errors, try to ensure dir once if it fails?
			// Simpler to just ignore for debug logs
		}
	}
}

// ==========================================
// TOOL CREATORS
// ==========================================

interface DelegateArgs {
	prompt: string
	agent: string
	model?: string
}

function createDelegate(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

Capacity is limited per model tier; excess delegations queue and start automatically.
On completion, a notification will arrive with the ID and terminal summary.
Use \`delegation_read\` with the ID to retrieve full persisted output (including after compaction).`,
		args: {
			prompt: tool.schema
				.string()
				.describe("The full detailed prompt for the agent. Must be in English."),
			agent: tool.schema
				.string()
				.describe(
					'Agent to delegate to. Must be a read-only sub-agent (edit/write/bash denied), such as "researcher" or "explore".',
				),
			model: tool.schema
				.string()
				.optional()
				.describe(
					'Optional model override in "provider/model" form, e.g. "lmstudio/qwen/qwen3.6-27b" to escalate one call to the top model or "lmstudio/qwen/qwen3.6-35b-a3b" to economize. Affects tier scheduling.',
				),
		},
		async execute(args: DelegateArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegate requires sessionID. This is a system error."
			}
			if (!toolCtx?.messageID) {
				return "❌ delegate requires messageID. This is a system error."
			}

			try {
				const delegation = await manager.delegate({
					parentSessionID: toolCtx.sessionID,
					parentMessageID: toolCtx.messageID,
					parentAgent: toolCtx.agent,
					prompt: args.prompt,
					agent: args.agent,
					options: args.model ? { model: args.model } : undefined,
				})

				// Get total active count for this parent session
				const totalActive = manager.getPendingCount(toolCtx.sessionID)

				let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}`
				if (args.model) {
					response += `\nModel override: ${args.model}`
				}
				if (delegation.tier) {
					response += `\nTier: ${delegation.tier} (capacity-managed; if slots are busy this queues and starts automatically)`
				}
				if (totalActive > 1) {
					response += `\n\n${totalActive} delegations now active.`
				}
				response += `\nYou WILL be notified when ${totalActive > 1 ? "ALL complete" : "complete"}. Do NOT poll.`

				return response
			} catch (error) {
				// Return validation errors as guidance, not exceptions
				return `❌ Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

function createDelegationCancel(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Cancel a queued or running delegation by its ID.
Queued delegations are removed without consuming a model slot; running delegations are aborted and their partial output is persisted.`,
		args: {
			id: tool.schema.string().describe("The delegation ID (e.g., 'elegant-blue-tiger')"),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_cancel requires sessionID. This is a system error."
			}
			try {
				return await manager.cancelDelegation(toolCtx.sessionID, args.id)
			} catch (error) {
				return `❌ Cancel failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

function createAgentsStatus(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Show model-tier slot occupancy (machine-wide) and this session's active delegations.
Call this ONCE when you want a snapshot of background capacity; never poll it.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ agents_status requires sessionID. This is a system error."
			}

			const sections: string[] = ["## Agent Capacity"]
			const scheduler = manager.getScheduler()
			if (!scheduler) {
				sections.push("Scheduler disabled: no tiers configured, all work dispatches immediately.")
			} else {
				const tiers = await scheduler.status()
				const now = Date.now()
				for (const tier of tiers) {
					sections.push(`\n### Tier "${tier.name}": ${tier.holders.length}/${tier.maxConcurrent} slots in use`)
					for (const holder of tier.holders) {
						const heldSeconds = Math.round((now - holder.acquiredAt) / 1000)
						const origin = holder.pid === process.pid ? "this process" : `pid ${holder.pid}`
						sections.push(
							`- slot ${holder.slot}: ${holder.kind}${holder.agent ? ` → ${holder.agent}` : ""}${holder.jobId ? ` (${holder.jobId})` : ""}, held ${heldSeconds}s, ${origin}`,
						)
					}
					for (const [index, waiting] of tier.localQueue.entries()) {
						sections.push(
							`- queued #${index + 1}: ${waiting.kind}${waiting.agent ? ` → ${waiting.agent}` : ""}${waiting.jobId ? ` (${waiting.jobId})` : ""}, waiting ${Math.round(waiting.waitingMs / 1000)}s`,
						)
					}
				}
				sections.push(
					"\nSlot occupancy is machine-wide (all opencode instances); the queue shown is this process's.",
				)
			}

			const active = await manager.describeActiveDelegations(toolCtx.sessionID)
			if (active.length > 0) {
				sections.push("\n## Active Delegations (this session)")
				sections.push(...active)
			}

			return sections.join("\n")
		},
	})
}

function createDelegationRead(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Read the output of a delegation by its ID.
Use this to retrieve results from delegated tasks if the inline notification was lost during compaction.`,
		args: {
			id: tool.schema.string().describe("The delegation ID (e.g., 'elegant-blue-tiger')"),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_read requires sessionID. This is a system error."
			}

			return await manager.readOutput(toolCtx.sessionID, args.id)
		},
	})
}

function createDelegationList(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `List all delegations for the current session.
Shows both running and completed delegations.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_list requires sessionID. This is a system error."
			}

			const delegations = await manager.listDelegations(toolCtx.sessionID)

			if (delegations.length === 0) {
				return "No delegations found for this session."
			}

			const lines = delegations.map((d) => {
				const titlePart = d.title ? ` | ${d.title}` : ""
				const unreadPart = d.unread ? " [unread]" : ""
				const descPart = d.description ? `\n  → ${d.description}` : ""
				return `- **${d.id}**${titlePart} [${d.status}]${unreadPart}${descPart}`
			})

			return `## Delegations\n\n${lines.join("\n")}`
		},
	})
}

// ==========================================
// DELEGATION RULES (injected into system prompt)
// ==========================================

const DELEGATION_RULES = `<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent, model?)\` - Launch task, returns ID immediately. Optional \`model\` ("provider/model") escalates or economizes one call, e.g. "lmstudio/qwen/qwen3.6-27b".
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)
- \`delegation_cancel(id)\` - Stop a queued or running delegation
- \`agents_status()\` - Snapshot of tier slots (machine-wide) and queued work

## Delegation Routing

Agents route based on their permissions:

| Agent Type | Tool | Why |
|------------|------|-----|
| Read-only sub-agents (edit/write/bash denied) | \`delegate\` | Background session, async |
| Write-capable sub-agents (any write permission) | \`task\` | Native task, preserves undo/branching |

**Read-only sub-agents** have edit="deny", write="deny", bash={"*":"deny"}.
**Write-capable sub-agents** have any write tool enabled.

## Concurrency and Queueing

Local model capacity is limited and shared machine-wide (defaults: top tier 1
concurrent, fast tier 3). Work beyond capacity QUEUES and starts automatically
when a slot frees. There is no wall-clock time limit; only genuinely stalled
agents are reaped.
- "queued" is normal and needs no action. Do NOT resubmit duplicates.
- If progress seems slow, call \`agents_status()\` ONCE. Never poll it.
- You will ALWAYS receive a \`<task-notification>\` per completed delegation.

## How It Works

1. For read-only sub-agents: Call \`delegate\` with detailed prompt
2. For write-capable sub-agents: Call \`task\` with detailed prompt
3. Continue productive work while it runs
4. Receive notification when complete
5. Call \`delegation_read(id)\` to retrieve results

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<task-notification>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

**Using wrong tool will fail fast with guidance.**

</delegation-system>`

// ==========================================
// COMPACTION CONTEXT FORMATTING
// ==========================================

interface DelegationForContext {
	id: string
	agent?: string
	title?: string
	description?: string
	status: DelegationStatus
	startedAt?: Date
	completedAt?: Date
	lastHeartbeatAt?: Date
	prompt?: string
}

/**
 * Format delegation context for injection during compaction.
 * Includes running delegations with notification reminder (only when running exist),
 * and recent completed delegations with full descriptions.
 */
function formatDelegationContext(
	running: DelegationForContext[],
	unreadCompleted: DelegationForContext[],
): string {
	const sections: string[] = ["<delegation-context>"]

	// Running delegations (if any)
	if (running.length > 0) {
		sections.push("## Running Delegations")
		sections.push("")
		for (const d of running) {
			sections.push(`### \`${d.id}\`${d.agent ? ` (${d.agent})` : ""}`)
			if (d.startedAt) {
				sections.push(`**Started:** ${d.startedAt.toISOString()}`)
			}
			if (d.lastHeartbeatAt) {
				sections.push(`**Last heartbeat:** ${d.lastHeartbeatAt.toISOString()}`)
			}
			if (d.prompt) {
				const truncatedPrompt = d.prompt.length > 200 ? `${d.prompt.slice(0, 200)}...` : d.prompt
				sections.push(`**Prompt:** ${truncatedPrompt}`)
			}
			sections.push("")
		}

		// Only include reminder when there ARE running delegations
		sections.push(
			"> **Note:** You WILL be notified via `<task-notification>` when delegations complete.",
		)
		sections.push("> Do NOT poll `delegation_list` - continue productive work.")
		sections.push("")
	}

	// Unread completed delegations (recent)
	if (unreadCompleted.length > 0) {
		sections.push("## Unread Completed Delegations")
		sections.push("")
		for (const d of unreadCompleted) {
			const statusEmoji =
				d.status === "complete"
					? "✅"
					: d.status === "error"
						? "❌"
						: d.status === "timeout"
							? "⏱️"
							: "🚫"
			sections.push(`### ${statusEmoji} \`${d.id}\``)
			sections.push(`**Title:** ${d.title || "(no title)"}`)
			sections.push(`**Status:** ${d.status}`)
			sections.push(`**Description:** ${d.description || "(no description)"}`)
			if (d.completedAt) {
				sections.push(`**Completed:** ${d.completedAt.toISOString()}`)
			}
			sections.push(`**Retrieve:** \`delegation_read("${d.id}")\``)
			sections.push("")
		}
		sections.push("> These are unread terminal delegations carried forward through compaction.")
		sections.push("")
	}

	sections.push("## Retrieval")
	sections.push('Use `delegation_read("id")` to access full delegation output.')
	sections.push("Do not poll delegation_list for completion; rely on task notifications.")
	sections.push("</delegation-context>")

	return sections.join("\n")
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

/**
 * Expected input for experimental.chat.system.transform hook.
 */
interface SystemTransformInput {
	agent?: string
	sessionID?: string
}

const BackgroundAgentsPlugin: Plugin = async (ctx) => {
	const { client, directory } = ctx

	// Create logger early for all components
	const log = createLogger(client as OpencodeClient)

	// Project-level storage directory (shared across sessions)
	// Uses git root commit hash for cross-worktree consistency
	const projectId = await getProjectId(directory)
	const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "delegations", projectId)

	// Ensure base directory exists (for debug logs etc)
	await fs.mkdir(baseDir, { recursive: true })

	// Harness config drives the tier scheduler, timeout policy, and metadata mode
	const { config: harness, warnings } = await loadHarnessConfig(directory)
	for (const warning of warnings) {
		log.warn(warning)
	}
	const scheduler = harness.tiers.length > 0 ? getScheduler(harness, log) : undefined
	if (scheduler) await scheduler.init()
	const resolver = scheduler
		? createTierResolver(client as OpencodeClient, scheduler, log)
		: undefined

	const manager = new DelegationManager(client as OpencodeClient, baseDir, log, {
		harness,
		scheduler,
		resolver,
	})
	manager.startInactivityWatchdog()

	// Bridge for the workflow plugin: same queue, same lifecycle, silent results.
	registerDelegationHandle({
		delegate: (input) => manager.delegate(input).then((delegation) => ({ id: delegation.id })),
		awaitResult: (id, opts) => manager.awaitResult(id, opts),
		cancel: async (id) => {
			await manager.cancelDelegationInternal(id, "Cancelled by workflow").catch(() => {})
		},
	})

	// Native task gating state: leases held for in-flight task tool calls and
	// abort controllers for calls still waiting on a slot.
	const taskLeases = new Map<string, Lease>()
	const taskWaitAborts = new Map<string, { controller: AbortController; sessionID: string }>()

	const releaseTaskResourcesForSession = (sessionID: string) => {
		for (const [callID, waiting] of taskWaitAborts) {
			if (waiting.sessionID === sessionID) {
				taskWaitAborts.delete(callID)
				waiting.controller.abort()
			}
		}
		for (const [callID, lease] of taskLeases) {
			if (lease.info.sessionID === sessionID) {
				taskLeases.delete(callID)
				void lease.release()
			}
		}
	}

	// Safety net: tool.execute.after does not fire for tools that error, so a
	// failed task call could hold its tier slot until the parent goes idle.
	// Reap anything held implausibly long.
	const taskLeaseStaleMs =
		harness.timeouts.toolCallStaleMs > 0
			? harness.timeouts.toolCallStaleMs
			: TASK_LEASE_STALE_FALLBACK_MS
	const taskLeaseSweep = setInterval(() => {
		const now = Date.now()
		for (const [callID, lease] of taskLeases) {
			if (now - lease.info.acquiredAt > taskLeaseStaleMs) {
				taskLeases.delete(callID)
				void lease.release()
				log.warn(`released stale task lease for call ${callID}`)
			}
		}
	}, 60_000)
	taskLeaseSweep.unref?.()

	await manager.debugLog("BackgroundAgentsPlugin initialized with delegation system")

	return {
		tool: {
			delegate: createDelegate(manager),
			delegation_read: createDelegationRead(manager),
			delegation_list: createDelegationList(manager),
			delegation_cancel: createDelegationCancel(manager),
			agents_status: createAgentsStatus(manager),
		},

		dispose: async () => {
			manager.stopInactivityWatchdog()
			clearInterval(taskLeaseSweep)
			for (const [, lease] of taskLeases) {
				await lease.release()
			}
			taskLeases.clear()
			if (scheduler) await scheduler.dispose()
		},

		// Route read-only agents to delegate, and gate write-capable native task
		// calls through the tier scheduler so they share the machine-wide caps.
		"tool.execute.before": async (
			input: { tool: string; sessionID: string; callID: string },
			output: { args?: { subagent_type?: string } },
		) => {
			// Track tool activity inside delegation child sessions (watchdog input)
			manager.noteToolStart(input.sessionID, input.callID)

			// Guard: Only intercept task tool
			if (input.tool !== "task") return

			// Guard: Require agent name
			const agentName = output.args?.subagent_type
			if (!agentName) return

			// Parse boundary 1: Check agent mode
			const { isSubAgent } = await parseAgentMode(client as OpencodeClient, agentName, log)

			// Guard: Allow non-sub-agents (main/built-in)
			if (!isSubAgent) return

			// Parse boundary 2: Check write capability (only for sub-agents)
			const { isReadOnly } = await parseAgentWriteCapability(
				client as OpencodeClient,
				agentName,
				log,
			)

			// Fail fast: Read-only sub-agent via task is invalid. This throw MUST
			// stay ahead of slot acquisition so rejected calls never leak a lease.
			if (isReadOnly) {
				throw new Error(
					`❌ Agent '${agentName}' is read-only and should use the delegate tool for async background execution.\n\n` +
						`Read-only agents have: edit="deny", write="deny", bash={"*":"deny"}\n` +
						`Use delegate for read-only sub-agents.\n` +
						`Use task for write-capable sub-agents.`,
				)
			}

			// Write-capable native task: hold a tier slot for the duration.
			if (!scheduler || !resolver) return
			const { tier } = await resolver.resolveAgentTier(agentName)
			if (!tier) return

			const controller = new AbortController()
			taskWaitAborts.set(input.callID, { controller, sessionID: input.sessionID })
			try {
				const lease = await scheduler.acquire(tier, {
					kind: "task",
					agent: agentName,
					sessionID: input.sessionID,
					jobId: input.callID,
					signal: controller.signal,
					maxWaitMs: harness.timeouts.queueWaitMs,
				})
				taskLeases.set(input.callID, lease)
			} catch (error) {
				if (error instanceof AcquireAbortedError) {
					throw new Error("Task cancelled while waiting for a model slot.")
				}
				if (error instanceof QueueWaitTimeoutError) {
					throw new Error(
						`Tier "${tier}" is saturated: ${error.message}. Check agents_status() for occupancy, or use delegate for async background work.`,
					)
				}
				throw error
			} finally {
				taskWaitAborts.delete(input.callID)
			}
		},

		// Release task slots when the task tool finishes, and track tool-call
		// completion for the inactivity watchdog.
		"tool.execute.after": async (input: { tool: string; sessionID: string; callID: string }) => {
			manager.noteToolEnd(input.sessionID, input.callID)
			if (input.tool !== "task") return
			const lease = taskLeases.get(input.callID)
			if (lease) {
				taskLeases.delete(input.callID)
				await lease.release()
			}
		},

		// Inject delegation rules into system prompt
		"experimental.chat.system.transform": async (_input: SystemTransformInput, output) => {
			output.system.push(DELEGATION_RULES)
		},

		// Deliver queued parent notifications on the next user turn if direct delivery failed.
		"chat.message": async (
			input: { sessionID?: string },
			output: { parts?: Array<{ type: string; text?: string }> },
		) => {
			if (!input.sessionID) return
			manager.injectPendingNotificationsIntoChatMessage(output, input.sessionID)
		},

		// Compaction hook - inject delegation context for context recovery
		"experimental.session.compacting": async (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => {
			const rootSessionID = await manager.getRootSessionID(input.sessionID)

			// Running delegations in this root session tree
			const running = manager.getRunningDelegations(rootSessionID).map((d) => ({
				id: d.id,
				agent: d.agent,
				title: d.title,
				description: d.description,
				status: d.status,
				startedAt: d.startedAt,
				lastHeartbeatAt: d.progress.lastHeartbeatAt,
				prompt: d.prompt,
			}))

			// Unread completed delegations to carry forward through compaction
			const unreadCompleted = manager.getUnreadCompletedDelegations(rootSessionID, 10).map((d) => ({
				id: d.id,
				agent: d.agent,
				title: d.title,
				description: d.description,
				status: d.status,
				completedAt: d.completedAt,
			}))

			// Early exit if nothing to inject
			if (running.length === 0 && unreadCompleted.length === 0) return

			output.context.push(formatDelegationContext(running, unreadCompleted))
		},

		// Event hook
		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type === "session.status") {
				const statusType = event.properties.status?.type
				const sessionID = event.properties.sessionID
				if (statusType === "idle" && sessionID) {
					releaseTaskResourcesForSession(sessionID)
					await manager.handleSessionIdle(sessionID)
				}
			}

			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID
				if (sessionID) {
					releaseTaskResourcesForSession(sessionID)
					await manager.handleSessionIdle(sessionID)
				}
			}

			if (event.type === "message.part.updated") {
				const partProperties = event.properties as { part?: { sessionID?: string } }
				const partSessionID = partProperties.part?.sessionID
				if (partSessionID) {
					manager.recordActivity(partSessionID)
				}
			}

			if (event.type === "message.updated") {
				const eventProperties = event.properties as {
					info: { sessionID?: string; role?: string }
					parts?: Part[]
				}
				const sessionID = eventProperties.info.sessionID
				if (sessionID) {
					const messageText =
						eventProperties.info.role === "assistant"
							? (eventProperties.parts
									?.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n") ?? undefined)
							: undefined
					manager.handleMessageEvent(sessionID, messageText)
				}
			}
		},
	}
}

const BackgroundAgentsPluginWithInternals = Object.assign(BackgroundAgentsPlugin, {
	testInternals: {
		DelegationManager,
		formatDelegationContext,
	},
} as const)

export default BackgroundAgentsPluginWithInternals
