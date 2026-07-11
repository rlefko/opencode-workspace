/**
 * claude-compat
 * Makes OpenCode read Claude Code project assets so the same repos work in
 * both harnesses:
 *
 * - CLAUDE.md is ALWAYS loaded (project root when AGENTS.md would otherwise
 *   shadow it, plus .claude/CLAUDE.md and ~/.claude/CLAUDE.md)
 * - .claude/agents/*.md become opencode subagents (models mapped to the
 *   local tiers: opus/sonnet -> top, haiku -> fast)
 * - .claude/commands/**\/*.md become slash commands (foo/bar.md -> /foo:bar)
 *
 * Not handled by design: .claude/skills (native in OpenCode), and
 * .claude/settings.json hooks (no OpenCode equivalent).
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { OpencodeClient } from "./kdco-primitives/types"
import { applyClaudeCompat, type MutableConfig } from "./lib/claude-assets"

const ClaudeCompatPlugin: Plugin = async (ctx) => {
	const client = ctx.client as OpencodeClient
	const worktree = ctx.worktree || ctx.directory

	const log = {
		info: (message: string) =>
			void client.app
				.log({ body: { service: "claude-compat", level: "info", message } })
				.catch(() => {}),
		warn: (message: string) =>
			void client.app
				.log({ body: { service: "claude-compat", level: "warn", message } })
				.catch(() => {}),
	}

	return {
		config: async (config) => {
			try {
				const report = await applyClaudeCompat(config as MutableConfig, worktree, log)
				const summary = [
					report.instructions.length > 0 ? `instructions: ${report.instructions.length}` : "",
					report.agents.length > 0 ? `agents: ${report.agents.join(", ")}` : "",
					report.commands.length > 0 ? `commands: ${report.commands.join(", ")}` : "",
					report.skipped.length > 0 ? `skipped: ${report.skipped.length}` : "",
				]
					.filter(Boolean)
					.join(" | ")
				if (summary) {
					log.info(`claude-compat loaded ${summary}`)
				}
			} catch (error) {
				// Never break config loading; compat is best-effort by design.
				log.warn(
					`claude-compat failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		},
	}
}

export default ClaudeCompatPlugin
