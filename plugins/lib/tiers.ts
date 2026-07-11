/**
 * tiers
 * Resolves which scheduler tier an agent's work belongs to by looking up the
 * agent's effective model and matching it against the configured tier lists.
 */

import type { TierScheduler } from "./scheduler"

export interface ModelRef {
	providerID: string
	modelID: string
}

export interface ResolvedTier {
	tier: string | null
	/** Composed "providerID/modelID" string for the model that will actually run. */
	model: string | undefined
	/** Split reference suitable for session.prompt's model field. */
	modelRef: ModelRef | undefined
}

interface AgentModelInfo {
	name: string
	model?: { providerID?: string; modelID?: string }
}

interface TierResolverClient {
	app: {
		agents(input: Record<string, never>): Promise<{ data?: unknown }>
	}
	config: {
		get(): Promise<{ data?: unknown }>
	}
}

interface TierResolverLogger {
	warn(message: string): void
}

const AGENT_CACHE_TTL_MS = 30_000

/**
 * Split a "providerID/modelID" string on the FIRST slash only. Model IDs can
 * themselves contain slashes (e.g. "lmstudio/qwen/qwen3.6-27b" is provider
 * "lmstudio" with model "qwen/qwen3.6-27b").
 */
export function splitModelRef(ref: string): ModelRef | undefined {
	const trimmed = ref.trim()
	const slash = trimmed.indexOf("/")
	if (slash <= 0 || slash === trimmed.length - 1) return undefined
	return {
		providerID: trimmed.slice(0, slash),
		modelID: trimmed.slice(slash + 1),
	}
}

export interface TierResolver {
	resolveAgentTier(agentName: string, overrideModel?: string): Promise<ResolvedTier>
	invalidate(): void
}

export function createTierResolver(
	client: TierResolverClient,
	scheduler: TierScheduler,
	log: TierResolverLogger,
): TierResolver {
	let agentCache: { agents: AgentModelInfo[]; fetchedAt: number } | undefined
	let defaultModelCache: { model: string | undefined; fetchedAt: number } | undefined

	const getAgents = async (): Promise<AgentModelInfo[]> => {
		if (agentCache && Date.now() - agentCache.fetchedAt < AGENT_CACHE_TTL_MS) {
			return agentCache.agents
		}
		try {
			const result = await client.app.agents({})
			const agents = (result.data ?? []) as AgentModelInfo[]
			agentCache = { agents, fetchedAt: Date.now() }
			return agents
		} catch (error) {
			log.warn(`tier resolver: agent list fetch failed: ${String(error)}`)
			return agentCache?.agents ?? []
		}
	}

	const getDefaultModel = async (): Promise<string | undefined> => {
		if (defaultModelCache && Date.now() - defaultModelCache.fetchedAt < AGENT_CACHE_TTL_MS) {
			return defaultModelCache.model
		}
		try {
			const result = await client.config.get()
			const model = (result.data as { model?: string } | undefined)?.model
			defaultModelCache = { model, fetchedAt: Date.now() }
			return model
		} catch (error) {
			log.warn(`tier resolver: config fetch failed: ${String(error)}`)
			return defaultModelCache?.model
		}
	}

	return {
		async resolveAgentTier(agentName: string, overrideModel?: string): Promise<ResolvedTier> {
			if (overrideModel) {
				const modelRef = splitModelRef(overrideModel)
				if (!modelRef) {
					throw new Error(
						`Invalid model override "${overrideModel}". Use "provider/model" form, e.g. "lmstudio/qwen/qwen3.6-27b".`,
					)
				}
				return {
					tier: scheduler.classify(overrideModel),
					model: overrideModel,
					modelRef,
				}
			}

			const agents = await getAgents()
			const agent = agents.find((a) => a.name === agentName)
			let model: string | undefined
			if (agent?.model?.providerID && agent.model.modelID) {
				model = `${agent.model.providerID}/${agent.model.modelID}`
			} else {
				model = await getDefaultModel()
			}

			if (!model) {
				log.warn(`tier resolver: no model resolved for agent "${agentName}"; leaving uncapped`)
				return { tier: null, model: undefined, modelRef: undefined }
			}

			return {
				tier: scheduler.classify(model),
				model,
				modelRef: undefined,
			}
		},
		invalidate() {
			agentCache = undefined
			defaultModelCache = undefined
		},
	}
}
