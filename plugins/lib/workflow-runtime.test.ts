import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { DelegationHandle, WorkflowDelegateInput } from "./delegation-registry"
import { runWorkflowScript } from "./workflow-runtime"
import { WorkflowJournal } from "./workflow-journal"

const tmpDirs: string[] = []

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

function makeHandle(reply: (input: WorkflowDelegateInput) => string): DelegationHandle & {
	calls: WorkflowDelegateInput[]
} {
	const calls: WorkflowDelegateInput[] = []
	const results = new Map<string, string>()
	let counter = 0
	return {
		calls,
		async delegate(input) {
			calls.push(input)
			const id = `job-${++counter}`
			results.set(id, reply(input))
			return { id }
		},
		async awaitResult(id) {
			return {
				id,
				status: "complete",
				text: results.get(id) ?? "",
				durationMs: 5,
			}
		},
		async cancel() {},
	}
}

async function run(script: string, handle: DelegationHandle, args: unknown = undefined) {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"))
	tmpDirs.push(baseDir)
	const journal = await WorkflowJournal.create(baseDir, "run-1", script, {})
	const result = await runWorkflowScript({
		script,
		args,
		sessionID: "session",
		messageID: "message",
		agentName: "build",
		abort: new AbortController().signal,
		handle,
		journal,
		client: { tui: { showToast: async () => ({}) } },
		updateMetadata: () => {},
	})
	return { result, journal, baseDir }
}

describe("runWorkflowScript", () => {
	test("runs a parallel fan-out and returns the combined result", async () => {
		const handle = makeHandle((input) => `reviewed: ${input.prompt.slice(0, 20)}`)
		const script = `
			phase("review")
			const dims = ["reuse", "simplification"]
			const results = await parallel(dims.map((d) => () =>
				agent("Check " + d, { agent: "reviewer", label: d })))
			return results.filter(Boolean).join(" | ")
		`
		const { result } = await run(script, handle)
		expect(result.status).toBe("complete")
		expect(result.value).toBe("reviewed: Check reuse | reviewed: Check simplification")
		expect(result.agentsStarted).toBe(2)
		expect(result.agentsCompleted).toBe(2)
		expect(result.phases).toEqual(["review"])
		expect(handle.calls.every((call) => call.options?.silent)).toBe(true)
	})

	test("schema calls return parsed objects", async () => {
		const handle = makeHandle(() => 'Sure thing:\n```json\n{"angles": [{"title": "t", "query": "q"}]}\n```')
		const script = `
			const scope = await agent("scope it", { schema: { type: "object", required: ["angles"],
				properties: { angles: { type: "array" } } } })
			return scope.angles.length
		`
		const { result } = await run(script, handle)
		expect(result.status).toBe("complete")
		expect(result.value).toBe(1)
	})

	test("pipeline stages flow per item and errors become null", async () => {
		const handle = makeHandle((input) => {
			if (input.prompt.includes("boom")) throw new Error("exploded")
			return input.prompt.toUpperCase()
		})
		const script = `
			const out = await pipeline(args.items,
				(item) => agent("first " + item),
				(prev) => agent("second " + prev))
			return out
		`
		const { result } = await run(script, handle, { items: ["ok", "boom"] })
		expect(result.status).toBe("complete")
		expect(result.value).toEqual(["SECOND FIRST OK", null])
	})

	test("compile errors are reported without throwing", async () => {
		const handle = makeHandle(() => "unused")
		const { result } = await run("const = broken", handle)
		expect(result.status).toBe("error")
		expect(result.error).toContain("compile error")
	})

	test("model override is validated and passed through", async () => {
		const handle = makeHandle(() => "done")
		const script = `return await agent("escalate", { model: "lmstudio/qwen/qwen3.6-27b" })`
		const { result } = await run(script, handle)
		expect(result.status).toBe("complete")
		expect(handle.calls[0].options?.model).toBe("lmstudio/qwen/qwen3.6-27b")
	})

	test("journal records the run lifecycle", async () => {
		const handle = makeHandle(() => "done")
		const script = `phase("p1"); log("working"); await agent("x"); return "ok"`
		const { journal } = await run(script, handle)
		const lines = await journal.tail(50)
		const types = lines.map((line) => JSON.parse(line).type)
		expect(types).toContain("run.start")
		expect(types).toContain("phase")
		expect(types).toContain("log")
		expect(types).toContain("agent.start")
		expect(types).toContain("agent.end")
		expect(types[types.length - 1]).toBe("run.end")
	})
})
