/**
 * workflow-runtime
 * Executes a workflow orchestration script in-process with injected helpers.
 * Scripts are plain JavaScript run through an AsyncFunction; the helpers
 * (agent, parallel, pipeline, phase, log) drive subagents through the
 * delegation bridge, so tier caps and queueing apply automatically.
 */

import type { DelegationHandle } from "./delegation-registry"
import { splitModelRef } from "./tiers"
import { buildSchemaInstruction, extractJson, validateAgainstSchema } from "./structured-output"
import type { WorkflowJournal } from "./workflow-journal"

export const WORKFLOW_LIMITS = {
	maxScriptLength: 32_000,
	maxAgentsPerRun: 50,
	schemaRetries: 1,
	toastThrottleMs: 5_000,
}

export interface WorkflowRunResult {
	status: "complete" | "error" | "aborted"
	value?: unknown
	error?: string
	agentsStarted: number
	agentsCompleted: number
	phases: string[]
	durationMs: number
}

export interface WorkflowAgentOptions {
	agent?: string
	model?: string
	schema?: object
	label?: string
}

interface ToastClient {
	tui: {
		showToast(input: {
			body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" }
		}): Promise<unknown>
	}
}

export interface RunWorkflowScriptOptions {
	script: string
	args: unknown
	sessionID: string
	messageID: string
	agentName: string
	abort: AbortSignal
	handle: DelegationHandle
	journal: WorkflowJournal
	client: ToastClient
	updateMetadata(state: {
		phase?: string
		lastLog?: string
		agentsStarted: number
		agentsCompleted: number
	}): void
	defaultAgent?: string
	/**
	 * Restrict spawned agents to read-only ones (plan-mode semantics): the
	 * delegation manager's read-only guard stays active instead of bypassed.
	 */
	enforceReadOnly?: boolean
}

export async function runWorkflowScript(
	options: RunWorkflowScriptOptions,
): Promise<WorkflowRunResult> {
	const startedAt = Date.now()
	const phases: string[] = []
	const inFlight = new Set<string>()
	let agentsStarted = 0
	let agentsCompleted = 0
	let currentPhase: string | undefined
	let lastLog: string | undefined
	let lastToastAt = 0

	const { script, args, abort, handle, journal, client, updateMetadata } = options
	const defaultAgent = options.defaultAgent ?? "general"

	const pushMetadata = () => {
		updateMetadata({ phase: currentPhase, lastLog, agentsStarted, agentsCompleted })
	}

	const toast = (message: string) => {
		const now = Date.now()
		if (now - lastToastAt < WORKFLOW_LIMITS.toastThrottleMs) return
		lastToastAt = now
		client.tui
			.showToast({ body: { title: "workflow", message: message.slice(0, 120), variant: "info" } })
			.catch(() => {})
	}

	const cancelInFlight = () => {
		for (const id of inFlight) {
			void handle.cancel(id).catch(() => {})
		}
	}
	const abortListener = () => cancelInFlight()
	abort.addEventListener("abort", abortListener, { once: true })

	const agentHelper = async (
		prompt: unknown,
		agentOptions: WorkflowAgentOptions = {},
	): Promise<unknown> => {
		if (abort.aborted) {
			throw new Error("Workflow aborted")
		}
		if (typeof prompt !== "string" || prompt.trim().length === 0) {
			throw new Error("agent(prompt) requires a non-empty string prompt")
		}
		if (agentOptions.model && !splitModelRef(agentOptions.model)) {
			throw new Error(
				`Invalid model "${agentOptions.model}". Use "provider/model" form, e.g. "lmstudio/qwen/qwen3.6-27b".`,
			)
		}

		const agentName = agentOptions.agent ?? defaultAgent
		const label = agentOptions.label ?? `${agentName}#${agentsStarted + 1}`
		pushMetadata()

		const fullPrompt = agentOptions.schema
			? `${prompt}\n${buildSchemaInstruction(agentOptions.schema)}`
			: prompt

		await journal.append({
			type: "agent.start",
			label,
			agent: agentName,
			model: agentOptions.model,
			phase: currentPhase,
			promptPreview: prompt.slice(0, 300),
		})

		const runOnce = async (promptText: string): Promise<string> => {
			// Budget counts every dispatch, including schema-repair retries.
			if (agentsStarted >= WORKFLOW_LIMITS.maxAgentsPerRun) {
				throw new Error(
					`Workflow agent budget exhausted (${WORKFLOW_LIMITS.maxAgentsPerRun} agent calls per run)`,
				)
			}
			agentsStarted += 1
			pushMetadata()
			const { id } = await handle.delegate({
				parentSessionID: options.sessionID,
				parentMessageID: options.messageID,
				parentAgent: options.agentName,
				prompt: promptText,
				agent: agentName,
				options: {
					skipReadOnlyGuard: !options.enforceReadOnly,
					silent: true,
					model: agentOptions.model,
				},
			})
			inFlight.add(id)
			try {
				const outcome = await handle.awaitResult(id, { signal: abort })
				if (outcome.status !== "complete") {
					throw new Error(
						`agent "${label}" (${outcome.id}) ended ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
					)
				}
				return outcome.text
			} finally {
				inFlight.delete(id)
			}
		}

		try {
			let text = await runOnce(fullPrompt)

			let result: unknown = text
			if (agentOptions.schema) {
				result = await parseWithSchema(text, agentOptions.schema, label, runOnce)
			}

			agentsCompleted += 1
			pushMetadata()
			await journal.append({
				type: "agent.end",
				label,
				status: "complete",
				outputPreview: text.slice(0, 300),
			})
			return result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await journal.append({ type: "agent.end", label, status: "error", error: message })
			throw error instanceof Error ? error : new Error(message)
		}
	}

	const parseWithSchema = async (
		text: string,
		schema: object,
		label: string,
		runOnce: (prompt: string) => Promise<string>,
	): Promise<unknown> => {
		let lastError = ""
		let currentText = text
		for (let attempt = 0; attempt <= WORKFLOW_LIMITS.schemaRetries; attempt++) {
			const extracted = extractJson(currentText)
			if (extracted.ok) {
				const validation = validateAgainstSchema(extracted.value, schema)
				if (validation.ok) return extracted.value
				lastError = `Schema validation failed: ${validation.errors.join("; ")}`
			} else {
				lastError = extracted.error
			}

			if (attempt < WORKFLOW_LIMITS.schemaRetries) {
				await journal.append({ type: "log", message: `${label}: schema repair retry (${lastError})` })
				currentText = await runOnce(
					[
						"Your previous reply did not satisfy the required JSON schema.",
						`Problem: ${lastError}`,
						"",
						"Previous reply:",
						currentText.slice(0, 4_000),
						buildSchemaInstruction(schema),
						"Reply with ONLY the corrected JSON.",
					].join("\n"),
				)
			}
		}
		throw new Error(`agent "${label}" failed schema validation after retry: ${lastError}`)
	}

	const parallelHelper = async (thunks: Array<() => Promise<unknown>>): Promise<Array<unknown>> => {
		if (!Array.isArray(thunks)) {
			throw new Error("parallel(thunks) requires an array of functions")
		}
		return await Promise.all(
			thunks.map((thunk, index) =>
				Promise.resolve()
					.then(() => (typeof thunk === "function" ? thunk() : thunk))
					.catch(async (error) => {
						await journal.append({
							type: "thunk.error",
							index,
							error: error instanceof Error ? error.message : String(error),
						})
						return null
					}),
			),
		)
	}

	const pipelineHelper = async (
		items: unknown[],
		...stages: Array<(value: unknown, original: unknown, index: number) => Promise<unknown>>
	): Promise<Array<unknown>> => {
		if (!Array.isArray(items)) {
			throw new Error("pipeline(items, ...stages) requires an items array")
		}
		return await Promise.all(
			items.map(async (item, index) => {
				let value: unknown = item
				try {
					for (const stage of stages) {
						value = await stage(value, item, index)
					}
					return value
				} catch (error) {
					await journal.append({
						type: "thunk.error",
						index,
						error: error instanceof Error ? error.message : String(error),
					})
					return null
				}
			}),
		)
	}

	const phaseHelper = (title: unknown): void => {
		const text = String(title)
		currentPhase = text
		phases.push(text)
		pushMetadata()
		void journal.append({ type: "phase", title: text })
		toast(text)
	}

	const logHelper = (message: unknown): void => {
		lastLog = String(message)
		pushMetadata()
		void journal.append({ type: "log", message: lastLog })
	}

	try {
		if (script.length > WORKFLOW_LIMITS.maxScriptLength) {
			throw new Error(
				`Workflow script too long (${script.length} chars; limit ${WORKFLOW_LIMITS.maxScriptLength})`,
			)
		}

		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
			...functionArgs: string[]
		) => (...invokeArgs: unknown[]) => Promise<unknown>

		let compiled: (...invokeArgs: unknown[]) => Promise<unknown>
		try {
			compiled = new AsyncFunction(
				"agent",
				"parallel",
				"pipeline",
				"phase",
				"log",
				"args",
				`"use strict";\n${script}`,
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await journal.finalize("error", `compile error: ${message}`)
			return {
				status: "error",
				error: `Script compile error: ${message}`,
				agentsStarted,
				agentsCompleted,
				phases,
				durationMs: Date.now() - startedAt,
			}
		}

		const value = await compiled(
			agentHelper,
			parallelHelper,
			pipelineHelper,
			phaseHelper,
			logHelper,
			args,
		)

		if (abort.aborted) {
			await journal.finalize("aborted", "aborted by user")
			return {
				status: "aborted",
				value,
				agentsStarted,
				agentsCompleted,
				phases,
				durationMs: Date.now() - startedAt,
			}
		}

		await journal.finalize("complete", "ok")
		return {
			status: "complete",
			value,
			agentsStarted,
			agentsCompleted,
			phases,
			durationMs: Date.now() - startedAt,
		}
	} catch (error) {
		cancelInFlight()
		const message = error instanceof Error ? error.message : String(error)
		const status = abort.aborted ? "aborted" : "error"
		await journal.finalize(status, message)
		return {
			status,
			error: message,
			agentsStarted,
			agentsCompleted,
			phases,
			durationMs: Date.now() - startedAt,
		}
	} finally {
		abort.removeEventListener("abort", abortListener)
	}
}
