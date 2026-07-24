/**
 * agent-tracker
 * On opencode 1.17.x the experimental.chat.system.transform hook receives only
 * {sessionID, model}; the agent name is never passed, so agent-conditional
 * system prompt injection silently never fires. chat.message DOES receive the
 * agent, so plugins record it here (shared module = process-wide singleton)
 * and transforms resolve through this cache, preferring input.agent whenever
 * a newer opencode starts providing it.
 */

const sessionAgents = new Map<string, string>()
const MAX_TRACKED_SESSIONS = 500

export function rememberSessionAgent(sessionID?: string, agent?: string): void {
	if (!sessionID || !agent) return
	// Re-insert to keep the map ordered by recency for cheap pruning.
	sessionAgents.delete(sessionID)
	sessionAgents.set(sessionID, agent)
	if (sessionAgents.size > MAX_TRACKED_SESSIONS) {
		const oldest = sessionAgents.keys().next().value
		if (oldest !== undefined) sessionAgents.delete(oldest)
	}
}

export function resolveSessionAgent(input: {
	agent?: string
	sessionID?: string
}): string | undefined {
	if (input.agent) return input.agent
	if (input.sessionID) return sessionAgents.get(input.sessionID)
	return undefined
}
