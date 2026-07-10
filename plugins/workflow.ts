/**
 * workflow
 * Scripted multi-agent orchestration for OpenCode, modeled on Claude Code's
 * Workflow tool. An orchestrator writes (or names) a small JavaScript script
 * with agent()/parallel()/pipeline()/phase()/log() helpers; every agent call
 * runs as a silent background delegation governed by the tier scheduler.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import { getProjectId } from "./kdco-primitives/get-project-id"
import type { OpencodeClient } from "./kdco-primitives/types"
import { getDelegationHandle } from "./lib/delegation-registry"
import { runWorkflowScript, WORKFLOW_LIMITS } from "./lib/workflow-runtime"
import { WorkflowJournal } from "./lib/workflow-journal"

const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

interface WorkflowRunState {
	runId: string
	name?: string
	phase?: string
	lastLog?: string
	agentsStarted: number
	agentsCompleted: number
	status: "running" | "complete" | "error" | "aborted"
	startedAt: Date
	sessionID: string
}

function generateRunId(): string {
	const now = new Date()
	const stamp = now
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14)
	const suffix = Math.random().toString(36).slice(2, 8)
	return `${stamp}-${suffix}`
}

async function resolveSavedWorkflow(
	name: string,
	worktree: string,
): Promise<{ script: string; sourcePath: string } | null> {
	const candidates = [
		path.join(worktree, ".opencode", "workflows", `${name}.js`),
		path.join(worktree, ".claude", "workflows", `${name}.js`),
		path.join(os.homedir(), ".opencode", "workflows", `${name}.js`),
		path.join(os.homedir(), ".claude", "workflows", `${name}.js`),
	]
	for (const candidate of candidates) {
		try {
			const script = await fs.readFile(candidate, "utf8")
			return { script, sourcePath: candidate }
		} catch {
			// Try the next location
		}
	}
	return null
}

async function listSavedWorkflows(worktree: string): Promise<string[]> {
	const dirs = [
		path.join(worktree, ".opencode", "workflows"),
		path.join(worktree, ".claude", "workflows"),
		path.join(os.homedir(), ".opencode", "workflows"),
		path.join(os.homedir(), ".claude", "workflows"),
	]
	const names = new Set<string>()
	for (const dir of dirs) {
		try {
			for (const entry of await fs.readdir(dir)) {
				if (entry.endsWith(".js")) names.add(entry.slice(0, -3))
			}
		} catch {
			// Missing dir
		}
	}
	return [...names].sort()
}

const WORKFLOW_RULES = `<workflow-tool>

## workflow: scripted multi-agent orchestration

Use \`workflow\` when a task needs MULTIPLE subagents with coordination
(fan-out, per-file pipelines, retry loops, research sweeps). For a single
background task use \`delegate\`; for a single write-capable subagent use \`task\`.

Script helpers (plain JavaScript, may end with a return statement):
- \`await agent(prompt, {agent?, model?, schema?, label?})\` - run a subagent,
  returns its final text (or a schema-validated object when \`schema\` is given).
  Default agent: "general". \`model\` ("provider/model") escalates one call.
- \`await parallel([...thunks])\` - run thunks concurrently; a failed thunk
  becomes null instead of failing the batch.
- \`await pipeline(items, ...stages)\` - each item flows through the stages
  independently, no barriers between stages.
- \`phase(title)\` / \`log(msg)\` - progress reporting. \`args\` is your input.

Example - parallel review fan-out:
  phase("review")
  const dims = ["reuse", "simplification", "readability", "performance"]
  const results = await parallel(dims.map(d => () =>
    agent("Review the current git diff for " + d + " issues only. Cite file:line.",
          {agent: "reviewer", label: d})))
  return results.filter(Boolean).join("\\n\\n---\\n\\n")

Example - pipeline over files:
  const out = await pipeline(args.files,
    (f) => agent("Summarize " + f, {agent: "explore"}),
    (s) => agent("List risks in:\\n" + s, {agent: "reviewer"}))
  return out

Example - loop until done:
  let notes = ""
  for (let i = 0; i < 3; i++) {
    await agent("Fix the failing tests. Notes so far:\\n" + notes, {agent: "coder"})
    const check = await agent("Run the test suite. Reply PASS or paste failures.", {agent: "general"})
    if (check.includes("PASS")) return "tests pass"
    notes = check
  }
  return "gave up after 3 rounds:\\n" + notes

Saved workflows: \`workflow\` with \`name\` runs .opencode/workflows/<name>.js or
.claude/workflows/<name>.js (project first, then global). "deep-research" ships
with this harness: workflow name="deep-research" args="<research question>".

Limits: max ${WORKFLOW_LIMITS.maxAgentsPerRun} agent calls per run. The call blocks until the script
finishes; agent concurrency is governed by the tier scheduler automatically.
Check workflow_status for run history.

</workflow-tool>`

interface SystemTransformInput {
	agent?: string
	sessionID?: string
}

const WorkflowPlugin: Plugin = async (ctx) => {
	const client = ctx.client as OpencodeClient
	const projectId = await getProjectId(ctx.directory)
	const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "workflows", projectId)
	await fs.mkdir(baseDir, { recursive: true })

	const runRegistry = new Map<string, WorkflowRunState>()

	const workflowTool = tool({
		description: `Run a JavaScript orchestration script that coordinates multiple subagents.
Provide either \`script\` (inline JavaScript using the agent/parallel/pipeline/phase/log helpers) or \`name\` (a saved workflow from .opencode/workflows/ or .claude/workflows/).
The call blocks until the script finishes and returns its result. Subagent concurrency is automatically capped per model tier; extra agents queue.`,
		args: {
			script: tool.schema
				.string()
				.optional()
				.describe(
					"Inline JavaScript body. In scope: agent(prompt, {agent?, model?, schema?, label?}), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args. May end with a return statement.",
				),
			name: tool.schema
				.string()
				.optional()
				.describe(
					'Name of a saved workflow (e.g. "deep-research") resolved from .opencode/workflows/<name>.js or .claude/workflows/<name>.js, project first then global.',
				),
			args: tool.schema
				.string()
				.optional()
				.describe(
					"Input for the script, exposed as the `args` global. JSON is parsed; anything else arrives as a string.",
				),
		},
		async execute(
			rawArgs: { script?: string; name?: string; args?: string },
			toolCtx: ToolContext,
		) {
			const handle = getDelegationHandle()
			if (!handle) {
				return "❌ workflow requires the background-agents plugin, which is not loaded."
			}

			const hasScript = typeof rawArgs.script === "string" && rawArgs.script.trim().length > 0
			const hasName = typeof rawArgs.name === "string" && rawArgs.name.trim().length > 0
			if (hasScript === hasName) {
				const saved = await listSavedWorkflows(toolCtx.worktree)
				return [
					"❌ Provide exactly one of `script` or `name`.",
					saved.length > 0 ? `Saved workflows available: ${saved.join(", ")}` : "",
					"Example: workflow script=\"const a = await agent('Summarize README.md', {agent: 'explore'}); return a\"",
				]
					.filter(Boolean)
					.join("\n")
			}

			let script = rawArgs.script ?? ""
			let sourcePath: string | undefined
			let workflowName: string | undefined
			if (hasName) {
				const name = rawArgs.name?.trim() ?? ""
				if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) {
					return `❌ Invalid workflow name "${name}". Names match ${SAVED_WORKFLOW_NAME_PATTERN}.`
				}
				const resolved = await resolveSavedWorkflow(name, toolCtx.worktree)
				if (!resolved) {
					const saved = await listSavedWorkflows(toolCtx.worktree)
					return `❌ Saved workflow "${name}" not found.${saved.length > 0 ? ` Available: ${saved.join(", ")}` : " No saved workflows exist yet."}`
				}
				script = resolved.script
				sourcePath = resolved.sourcePath
				workflowName = name
			}

			let parsedArgs: unknown = rawArgs.args
			if (typeof rawArgs.args === "string" && rawArgs.args.trim().length > 0) {
				try {
					parsedArgs = JSON.parse(rawArgs.args)
				} catch {
					parsedArgs = rawArgs.args
				}
			}

			const runId = generateRunId()
			const journal = await WorkflowJournal.create(baseDir, runId, script, {
				name: workflowName,
				sourcePath,
				sessionID: toolCtx.sessionID,
				agent: toolCtx.agent,
				args: typeof parsedArgs === "string" ? parsedArgs.slice(0, 500) : parsedArgs,
			})

			const state: WorkflowRunState = {
				runId,
				name: workflowName,
				agentsStarted: 0,
				agentsCompleted: 0,
				status: "running",
				startedAt: new Date(),
				sessionID: toolCtx.sessionID,
			}
			runRegistry.set(runId, state)

			const result = await runWorkflowScript({
				script,
				args: parsedArgs,
				sessionID: toolCtx.sessionID,
				messageID: toolCtx.messageID,
				agentName: toolCtx.agent,
				abort: toolCtx.abort,
				handle,
				journal,
				client,
				updateMetadata: (progress) => {
					state.phase = progress.phase
					state.lastLog = progress.lastLog
					state.agentsStarted = progress.agentsStarted
					state.agentsCompleted = progress.agentsCompleted
					toolCtx.metadata({
						title: `workflow ${runId}${progress.phase ? `: ${progress.phase}` : ""}`,
						metadata: {
							runId,
							phase: progress.phase,
							lastLog: progress.lastLog,
							agentsStarted: progress.agentsStarted,
							agentsCompleted: progress.agentsCompleted,
						},
					})
				},
			})

			state.status = result.status

			const valueText =
				result.value === undefined
					? ""
					: typeof result.value === "string"
						? result.value
						: JSON.stringify(result.value, null, 2)

			const summaryLines = [
				`Workflow ${runId} ${result.status} in ${Math.round(result.durationMs / 1000)}s`,
				`Agents: ${result.agentsCompleted}/${result.agentsStarted} completed${result.phases.length > 0 ? ` | Phases: ${result.phases.join(" → ")}` : ""}`,
				`Journal: ${journal.journalFilePath}`,
			]

			if (result.status !== "complete") {
				const tail = await journal.tail(10)
				summaryLines.push(`Error: ${result.error ?? "aborted"}`)
				if (tail.length > 0) {
					summaryLines.push("", "Journal tail:", ...tail)
				}
			}

			return {
				title: `workflow ${runId} ${result.status}`,
				output: valueText.length > 0 ? `${valueText}\n\n---\n${summaryLines.join("\n")}` : summaryLines.join("\n"),
				metadata: {
					runId,
					status: result.status,
					agentsStarted: result.agentsStarted,
					agentsCompleted: result.agentsCompleted,
					phases: result.phases,
					journalPath: journal.journalFilePath,
				},
			}
		},
	})

	const workflowStatusTool = tool({
		description: `List workflow runs: in-memory runs from this process plus recent persisted runs.
Read a run's journal.jsonl for full detail.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext) {
			const lines: string[] = ["## Workflow Runs"]

			if (runRegistry.size > 0) {
				for (const state of [...runRegistry.values()].sort(
					(a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
				)) {
					const elapsed = Math.round((Date.now() - state.startedAt.getTime()) / 1000)
					lines.push(
						`- **${state.runId}**${state.name ? ` (${state.name})` : ""} [${state.status}] agents ${state.agentsCompleted}/${state.agentsStarted}${state.phase ? `, phase: ${state.phase}` : ""}, started ${elapsed}s ago`,
					)
				}
			}

			try {
				const entries = await fs.readdir(baseDir)
				const persisted = entries
					.filter((entry) => !runRegistry.has(entry))
					.sort()
					.slice(-5)
				for (const entry of persisted) {
					lines.push(`- ${entry} (persisted; journal at ${path.join(baseDir, entry, "journal.jsonl")})`)
				}
			} catch {
				// No persisted runs yet
			}

			if (lines.length === 1) {
				lines.push("No workflow runs recorded.")
			}

			const saved = await listSavedWorkflows(toolCtx.worktree)
			if (saved.length > 0) {
				lines.push("", `Saved workflows: ${saved.join(", ")}`)
			}

			return lines.join("\n")
		},
	})

	return {
		tool: {
			workflow: workflowTool,
			workflow_status: workflowStatusTool,
		},

		"experimental.chat.system.transform": async (input: SystemTransformInput, output) => {
			if (input.agent === "plan" || input.agent === "build") {
				output.system.push(WORKFLOW_RULES)
			}
		},
	}
}

export default WorkflowPlugin
