/**
 * harness-config
 * Loads and validates harness.jsonc, the configuration for the tiered agent
 * scheduler and delegation lifecycle.
 *
 * Search order (first found wins as the global layer):
 *   ~/.opencode/harness.jsonc
 *   ~/.config/opencode/harness.jsonc
 * A project may override any top-level key with <project>/.opencode/harness.jsonc
 * (shallow merge per top-level key, project wins; "tiers" is replaced wholesale).
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

const TierSchema = z.object({
	name: z.string().min(1),
	models: z.array(z.string().min(1)).min(1),
	maxConcurrent: z.number().int().min(1),
})

const HarnessSchema = z.object({
	tiers: z.array(TierSchema),
	defaultTier: z.string().nullable(),
	timeouts: z.object({
		/** Wall-clock budget per delegation, armed at dispatch. 0 = unlimited. */
		dispatchBudgetMs: z.number().int().min(0),
		/** Max quiet time (no stream output, no tool in flight). 0 = disabled. */
		inactivityMs: z.number().int().min(0),
		/** Max time queued work waits for a tier slot. 0 = wait indefinitely. */
		queueWaitMs: z.number().int().min(0),
		/** Bounded wait used by delegation_read on in-flight delegations. */
		readWaitMs: z.number().int().min(0),
	}),
	scheduler: z.object({
		crossProcess: z.boolean(),
		leaseDir: z.string().min(1),
		heartbeatMs: z.number().int().min(1000),
		staleMs: z.number().int().min(5000),
		pollMs: z.number().int().min(50),
	}),
	metadata: z.object({
		useLlm: z.boolean(),
	}),
})

export type TierConfig = z.infer<typeof TierSchema>
export type HarnessConfig = z.infer<typeof HarnessSchema>

export const HARNESS_DEFAULTS: HarnessConfig = {
	tiers: [
		{ name: "top", models: ["lmstudio/qwen/qwen3.6-27b"], maxConcurrent: 1 },
		{ name: "fast", models: ["lmstudio/qwen/qwen3.6-35b-a3b"], maxConcurrent: 3 },
	],
	defaultTier: null,
	timeouts: {
		dispatchBudgetMs: 0,
		inactivityMs: 900_000,
		queueWaitMs: 0,
		readWaitMs: 10_000,
	},
	scheduler: {
		crossProcess: true,
		leaseDir: "~/.local/share/opencode/workspace/scheduler",
		heartbeatMs: 15_000,
		staleMs: 60_000,
		pollMs: 500,
	},
	metadata: {
		useLlm: false,
	},
}

export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir()
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
	return value
}

async function readJsoncFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(filePath, "utf8")
		const parsed = parseJsonc(raw) as unknown
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return null
	} catch {
		return null
	}
}

function shallowMergeLayer(
	base: Record<string, unknown>,
	layer: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base }
	for (const [key, value] of Object.entries(layer)) {
		if (value === undefined) continue
		const existing = merged[key]
		const bothPlainObjects =
			existing &&
			value &&
			typeof existing === "object" &&
			typeof value === "object" &&
			!Array.isArray(existing) &&
			!Array.isArray(value)
		// Arrays (like "tiers") replace wholesale; nested objects merge per key so a
		// project can override a single timeout without restating the rest.
		merged[key] = bothPlainObjects
			? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
			: value
	}
	return merged
}

export interface HarnessConfigLoadResult {
	config: HarnessConfig
	sources: string[]
	warnings: string[]
}

export async function loadHarnessConfig(projectDir: string): Promise<HarnessConfigLoadResult> {
	const warnings: string[] = []
	const sources: string[] = []

	const globalCandidates = [
		path.join(os.homedir(), ".opencode", "harness.jsonc"),
		path.join(os.homedir(), ".config", "opencode", "harness.jsonc"),
	]
	const projectCandidate = path.join(projectDir, ".opencode", "harness.jsonc")

	let merged: Record<string, unknown> = { ...(HARNESS_DEFAULTS as unknown as Record<string, unknown>) }

	for (const candidate of globalCandidates) {
		const layer = await readJsoncFile(candidate)
		if (layer) {
			merged = shallowMergeLayer(merged, layer)
			sources.push(candidate)
			break
		}
	}

	const projectLayer = await readJsoncFile(projectCandidate)
	if (projectLayer) {
		merged = shallowMergeLayer(merged, projectLayer)
		sources.push(projectCandidate)
	}

	const validated = HarnessSchema.safeParse(merged)
	if (!validated.success) {
		warnings.push(
			`harness.jsonc validation failed, falling back to defaults: ${validated.error.message}`,
		)
		return { config: HARNESS_DEFAULTS, sources, warnings }
	}

	const config = validated.data
	if (config.scheduler.staleMs <= config.scheduler.heartbeatMs) {
		warnings.push(
			`scheduler.staleMs (${config.scheduler.staleMs}) should be well above heartbeatMs (${config.scheduler.heartbeatMs}); healthy leases may be reaped`,
		)
	}
	config.scheduler.leaseDir = expandHomePath(config.scheduler.leaseDir)
	return { config, sources, warnings }
}
