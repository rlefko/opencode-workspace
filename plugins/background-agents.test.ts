import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import plugin from "./background-agents"
import { HARNESS_DEFAULTS, type HarnessConfig } from "./lib/harness-config"
import { TierScheduler } from "./lib/scheduler"
import { createTierResolver } from "./lib/tiers"

const { DelegationManager } = plugin.testInternals

interface PromptCall {
	path: { id: string }
	body: {
		agent?: string
		model?: { providerID: string; modelID: string }
		parts: Array<{ type: string; text: string }>
		tools?: Record<string, boolean>
	}
	resolve: () => void
	reject: (error: Error) => void
}

function makeHarness(): HarnessConfig {
	return {
		...HARNESS_DEFAULTS,
		tiers: [
			{ name: "top", models: ["lmstudio/qwen/qwen3.6-27b"], maxConcurrent: 1 },
			{ name: "fast", models: ["lmstudio/qwen/qwen3.6-35b-a3b"], maxConcurrent: 3 },
		],
		timeouts: { ...HARNESS_DEFAULTS.timeouts, readWaitMs: 100 },
		scheduler: { ...HARNESS_DEFAULTS.scheduler, crossProcess: false, pollMs: 25 },
	}
}

function makeMockClient(agents: Array<{ name: string; mode: string; model?: { providerID: string; modelID: string } }>) {
	const promptCalls: PromptCall[] = []
	let sessionCounter = 0
	const abortedSessions: string[] = []

	const client = {
		app: {
			agents: async () => ({ data: agents }),
			log: async () => ({}),
		},
		config: {
			get: async () => ({
				data: {
					model: "lmstudio/qwen/qwen3.6-27b",
					agent: {
						explore: {
							permission: { edit: "deny", write: "deny", bash: { "*": "deny" } },
						},
						researcher: {
							permission: { edit: "deny", write: "deny", bash: { "*": "deny" } },
						},
						coder: {
							permission: { edit: "allow", write: "allow", bash: "allow" },
						},
					},
				},
			}),
		},
		session: {
			create: async () => ({ data: { id: `session-${++sessionCounter}` } }),
			prompt: (input: { path: { id: string }; body: PromptCall["body"] }) =>
				new Promise<void>((resolve, reject) => {
					promptCalls.push({ path: input.path, body: input.body, resolve, reject })
				}),
			promptAsync: async () => ({}),
			messages: async () => ({
				data: [
					{
						info: { role: "assistant" },
						parts: [{ type: "text", text: "the result" }],
					},
				],
			}),
			abort: async (input: { path: { id: string } }) => {
				abortedSessions.push(input.path.id)
				return {}
			},
			delete: async () => ({}),
			get: async () => ({ data: {} }),
		},
	}

	return { client, promptCalls, abortedSessions }
}

const tmpDirs: string[] = []

async function makeManager(
	mock: ReturnType<typeof makeMockClient>,
	harness: HarnessConfig = makeHarness(),
) {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "delegations-test-"))
	tmpDirs.push(baseDir)
	const log = { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} }
	const scheduler = new TierScheduler(harness)
	await scheduler.init()
	const resolver = createTierResolver(
		mock.client as never,
		scheduler,
		{ warn: () => {} },
	)
	const manager = new DelegationManager(mock.client as never, baseDir, log as never, {
		harness,
		scheduler,
		resolver,
	})
	return { manager, scheduler }
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

const AGENTS = [
	{ name: "explore", mode: "subagent", model: { providerID: "lmstudio", modelID: "qwen/qwen3.6-35b-a3b" } },
	{ name: "researcher", mode: "subagent", model: { providerID: "lmstudio", modelID: "qwen/qwen3.6-35b-a3b" } },
	{ name: "coder", mode: "subagent", model: { providerID: "lmstudio", modelID: "qwen/qwen3.6-27b" } },
]

async function settle(ms = 50) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("delegation queueing", () => {
	test("fast tier dispatches up to 3 and queues the fourth", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		const delegations = []
		for (let i = 0; i < 4; i++) {
			delegations.push(
				await manager.delegate({
					parentSessionID: "parent",
					parentMessageID: "message",
					parentAgent: "build",
					prompt: `job ${i}`,
					agent: "explore",
				}),
			)
		}
		await settle()

		expect(mock.promptCalls).toHaveLength(3)
		const fourth = delegations[3]
		expect(["queued", "registered"]).toContain(fourth.status)

		// Finish one running delegation; the queued one should dispatch.
		mock.promptCalls[0].resolve()
		await settle(150)
		expect(mock.promptCalls).toHaveLength(4)
		expect(fourth.status).toBe("running")
	})

	test("model override reroutes tier and rides the prompt body", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		const first = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "escalated",
			agent: "explore",
			options: { model: "lmstudio/qwen/qwen3.6-27b" },
		})
		await settle()

		expect(first.tier).toBe("top")
		expect(mock.promptCalls).toHaveLength(1)
		expect(mock.promptCalls[0].body.model).toEqual({
			providerID: "lmstudio",
			modelID: "qwen/qwen3.6-27b",
		})

		// Top tier cap is 1: a second escalated delegation must queue.
		const second = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "escalated too",
			agent: "explore",
			options: { model: "lmstudio/qwen/qwen3.6-27b" },
		})
		await settle()
		expect(second.status).toBe("queued")
		expect(mock.promptCalls).toHaveLength(1)

		mock.promptCalls[0].resolve()
		await settle(150)
		expect(mock.promptCalls).toHaveLength(2)
	})

	test("cancel while queued never consumes a slot", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager, scheduler } = await makeManager(mock)

		const running = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "occupies top",
			agent: "coder",
			options: { skipReadOnlyGuard: true },
		})
		await settle()
		const queued = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "queued behind",
			agent: "coder",
			options: { skipReadOnlyGuard: true },
		})
		await settle()
		expect(queued.status).toBe("queued")

		const message = await manager.cancelDelegationInternal(queued.id, "test cancel")
		expect(message).toContain("cancelled while queued")
		expect(queued.status).toBe("cancelled")

		const status = await scheduler.status()
		const top = status.find((tier) => tier.name === "top")
		expect(top?.localQueue).toHaveLength(0)

		expect(mock.abortedSessions).toHaveLength(0)
		expect(running.status).toBe("running")
	})

	test("cancel while running aborts the session and persists partial output", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		const delegation = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "long runner",
			agent: "explore",
		})
		await settle()
		expect(delegation.status).toBe("running")

		await manager.cancelDelegationInternal(delegation.id, "test cancel")
		expect(delegation.status).toBe("cancelled")
		expect(mock.abortedSessions).toContain(delegation.sessionID)

		const outcome = await manager.awaitResult(delegation.id)
		expect(outcome.status).toBe("cancelled")
		expect(outcome.text).toContain("[CANCELLED]")
		expect(outcome.text).toContain("the result")
	})

	test("awaitResult resolves with the delegation text on completion", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		const delegation = await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "do research",
			agent: "researcher",
			options: { silent: true },
		})
		await settle()

		const pendingOutcome = manager.awaitResult(delegation.id)
		mock.promptCalls[0].resolve()
		const outcome = await pendingOutcome
		expect(outcome.status).toBe("complete")
		expect(outcome.text).toBe("the result")
	})

	test("silent delegations skip parent notification bookkeeping", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		await manager.delegate({
			parentSessionID: "parent",
			parentMessageID: "message",
			parentAgent: "build",
			prompt: "quiet work",
			agent: "explore",
			options: { silent: true },
		})
		await settle()
		expect(manager.getPendingCount("parent")).toBe(0)
	})

	test("read-only guard still rejects write-capable agents without the bypass", async () => {
		const mock = makeMockClient(AGENTS)
		const { manager } = await makeManager(mock)

		// coder resolves as write-capable via config.get permissions (empty =
		// write-capable in parseAgentWriteCapability's model).
		await expect(
			manager.delegate({
				parentSessionID: "parent",
				parentMessageID: "message",
				parentAgent: "build",
				prompt: "write things",
				agent: "coder",
			}),
		).rejects.toThrow(/write-capable/)
	})
})
