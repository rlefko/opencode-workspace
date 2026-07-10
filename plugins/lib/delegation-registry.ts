/**
 * delegation-registry
 * Process-wide bridge between the background-agents delegation manager and
 * other plugins (currently the workflow plugin). Both sides import this module
 * by relative path, so Bun's module cache guarantees a shared singleton.
 */

export interface WorkflowDelegateOptions {
	/**
	 * Allow write-capable agents. Only workflow-originated delegations set this;
	 * the delegate tool keeps its read-only routing guard.
	 */
	skipReadOnlyGuard?: boolean
	/** Suppress parent notifications and metadata generation. */
	silent?: boolean
	/** Per-delegation model override in "provider/model" form. */
	model?: string
}

export interface WorkflowDelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	options?: WorkflowDelegateOptions
}

export type DelegationOutcomeStatus = "complete" | "error" | "cancelled" | "timeout"

export interface DelegationOutcome {
	id: string
	status: DelegationOutcomeStatus
	text: string
	error?: string
	durationMs: number
}

export interface DelegationHandle {
	delegate(input: WorkflowDelegateInput): Promise<{ id: string }>
	awaitResult(id: string, opts?: { signal?: AbortSignal }): Promise<DelegationOutcome>
	cancel(id: string): Promise<void>
}

let handle: DelegationHandle | undefined

export function registerDelegationHandle(h: DelegationHandle): void {
	handle = h
}

export function getDelegationHandle(): DelegationHandle | undefined {
	return handle
}
