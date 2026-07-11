/**
 * workflow-journal
 * Durable per-run record of a workflow execution: the script, its metadata,
 * and a JSONL journal of every phase, log line, and agent call. Journal
 * failures are never fatal to the run.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface WorkflowJournalEvent {
	type:
		| "run.start"
		| "phase"
		| "log"
		| "agent.start"
		| "agent.end"
		| "thunk.error"
		| "run.end"
	[key: string]: unknown
}

export class WorkflowJournal {
	private readonly journalPath: string
	private writeChain: Promise<void> = Promise.resolve()

	private constructor(
		readonly runDir: string,
		journalPath: string,
	) {
		this.journalPath = journalPath
	}

	static async create(
		baseDir: string,
		runId: string,
		script: string,
		meta: Record<string, unknown>,
	): Promise<WorkflowJournal> {
		const runDir = path.join(baseDir, runId)
		await fs.mkdir(runDir, { recursive: true })
		await fs.writeFile(path.join(runDir, "script.js"), script, "utf8")
		await fs.writeFile(
			path.join(runDir, "meta.json"),
			JSON.stringify({ runId, startedAt: new Date().toISOString(), ...meta }, null, "\t"),
			"utf8",
		)
		const journal = new WorkflowJournal(runDir, path.join(runDir, "journal.jsonl"))
		await journal.append({ type: "run.start", runId })
		return journal
	}

	get journalFilePath(): string {
		return this.journalPath
	}

	append(event: WorkflowJournalEvent): Promise<void> {
		const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
		this.writeChain = this.writeChain
			.then(() => fs.appendFile(this.journalPath, line, "utf8"))
			.catch(() => {})
		return this.writeChain
	}

	async finalize(status: "complete" | "error" | "aborted", summary: string): Promise<void> {
		await this.append({ type: "run.end", status, summary })
	}

	async tail(lines: number): Promise<string[]> {
		try {
			const content = await fs.readFile(this.journalPath, "utf8")
			return content.trim().split("\n").slice(-lines)
		} catch {
			return []
		}
	}
}
