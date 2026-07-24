/**
 * claude-assets
 * Scanners and mappers that translate Claude Code project assets into
 * OpenCode config: CLAUDE.md instruction files, .claude/agents/*.md
 * subagents, and .claude/commands/**\/*.md slash commands.
 *
 * Skills are deliberately NOT handled here: OpenCode discovers
 * .claude/skills/ natively.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { parseFrontmatter } from "./frontmatter"

export const TOP_TIER_MODEL = "lmstudio/qwen/qwen3.6-27b"
export const FAST_TIER_MODEL = "lmstudio/qwen/qwen3.6-35b-a3b"

/** Instruction files above this size are skipped to protect local context. */
const MAX_INSTRUCTION_BYTES = 48 * 1024
const MAX_COMMAND_DEPTH = 3

export interface CompatReport {
	instructions: string[]
	agents: string[]
	commands: string[]
	skipped: string[]
}

export interface CompatLogger {
	info(message: string): void
	warn(message: string): void
}

type PermissionValue = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">

export interface InjectableAgentConfig {
	description?: string
	mode?: string
	model?: string
	prompt?: string
	color?: string
	permission?: Record<string, PermissionValue>
	[key: string]: unknown
}

export interface InjectableCommandConfig {
	template: string
	description?: string
	agent?: string
	model?: string
	subtask?: boolean
}

export interface MutableConfig {
	instructions?: string[]
	agent?: Record<string, unknown>
	command?: Record<string, unknown>
	[key: string]: unknown
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

async function fileSize(filePath: string): Promise<number> {
	try {
		const stat = await fs.stat(filePath)
		return stat.size
	} catch {
		return -1
	}
}

/**
 * Map a Claude Code model alias to the local tiers. Opus and sonnet land on
 * the top model, haiku on the fast model, inherit/unknown stays unset.
 */
export function mapClaudeModel(model: string | undefined): string | undefined {
	if (!model) return undefined
	const normalized = model.trim().toLowerCase()
	if (!normalized || normalized === "inherit") return undefined
	if (normalized.includes("haiku")) return FAST_TIER_MODEL
	if (normalized.includes("opus") || normalized.includes("sonnet")) return TOP_TIER_MODEL
	// Unknown alias or explicit full model ID: keep the agent's inherited model.
	return undefined
}

/**
 * Translate a Claude Code `tools` list into an opencode permission block.
 * Starts from a deny baseline and opens only what the list names. Returns
 * undefined when no tools list exists (inherit everything).
 */
export function mapClaudeTools(
	tools: string | undefined,
): Record<string, PermissionValue> | undefined {
	if (!tools || tools.trim().length === 0) return undefined

	const permission: Record<string, PermissionValue> = {
		edit: "deny",
		write: "deny",
		bash: { "*": "deny" },
		webfetch: "deny",
		websearch: "deny",
	}

	for (const rawName of tools.split(",")) {
		const name = rawName.trim().toLowerCase()
		switch (name) {
			case "read":
				permission.read = "allow"
				break
			case "grep":
				permission.grep = "allow"
				break
			case "glob":
				permission.glob = "allow"
				break
			case "edit":
			case "multiedit":
			case "notebookedit":
				permission.edit = "allow"
				break
			case "write":
				// opencode's write tool requests the "edit" permission; keep the
				// "write" key too for read-only capability detection.
				permission.write = "allow"
				permission.edit = "allow"
				break
			case "bash":
				permission.bash = "allow"
				break
			case "webfetch":
				permission.webfetch = "allow"
				break
			case "websearch":
				permission.websearch = "allow"
				break
			default:
				// Task, TodoWrite, Skill and unknown names have no direct opencode
				// equivalent at the permission layer; ignored by design.
				break
		}
	}

	return permission
}

export function sanitizeAgentName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

/**
 * CLAUDE.md loading, Claude Code style: always in context.
 * OpenCode natively loads a project CLAUDE.md only when AGENTS.md is absent,
 * and never looks at .claude/CLAUDE.md or ~/.claude/CLAUDE.md.
 */
export async function collectClaudeInstructions(
	worktree: string,
	report: CompatReport,
	log: CompatLogger,
	existing: string[],
): Promise<string[]> {
	const candidates: Array<{ filePath: string; onlyWithAgentsMd: boolean }> = [
		{ filePath: path.join(worktree, "CLAUDE.md"), onlyWithAgentsMd: true },
		{ filePath: path.join(worktree, ".claude", "CLAUDE.md"), onlyWithAgentsMd: false },
		{ filePath: path.join(os.homedir(), ".claude", "CLAUDE.md"), onlyWithAgentsMd: false },
	]

	const agentsMdExists = await fileExists(path.join(worktree, "AGENTS.md"))
	const existingResolved = new Set(existing.map((entry) => path.resolve(entry)))
	const added: string[] = []

	for (const candidate of candidates) {
		// Without AGENTS.md, opencode's native fallback already loads the root
		// CLAUDE.md; adding it again would double-inject.
		if (candidate.onlyWithAgentsMd && !agentsMdExists) continue
		if (!(await fileExists(candidate.filePath))) continue

		const resolved = path.resolve(candidate.filePath)
		if (existingResolved.has(resolved)) continue

		const size = await fileSize(resolved)
		if (size > MAX_INSTRUCTION_BYTES) {
			report.skipped.push(`${resolved} (instructions file too large: ${size} bytes)`)
			log.warn(`claude-compat: skipping oversized instructions file ${resolved} (${size} bytes)`)
			continue
		}

		existingResolved.add(resolved)
		added.push(resolved)
		report.instructions.push(resolved)
	}

	return added
}

interface ParsedAgentFile {
	name: string
	config: InjectableAgentConfig
	sourcePath: string
}

async function parseAgentFile(filePath: string): Promise<ParsedAgentFile | null> {
	const content = await fs.readFile(filePath, "utf8")
	const { data, body } = parseFrontmatter(content)

	const fallbackName = path.basename(filePath, ".md")
	const name = sanitizeAgentName(data.name || fallbackName)
	if (!name) return null

	const prompt = body.trim()
	if (!prompt) return null

	const config: InjectableAgentConfig = {
		description: data.description || `Imported from ${filePath}`,
		mode: "subagent",
		prompt,
	}

	const model = mapClaudeModel(data.model)
	if (model) config.model = model

	const permission = mapClaudeTools(data.tools)
	if (permission) config.permission = permission

	if (data.color && /^#[0-9a-fA-F]{3,8}$/.test(data.color)) {
		config.color = data.color
	}

	return { name, config, sourcePath: filePath }
}

/**
 * Discover .claude/agents/*.md subagents. Global (~/.claude/agents) first,
 * project overrides on collision; existing opencode agents always win.
 */
export async function collectClaudeAgents(
	worktree: string,
	report: CompatReport,
	log: CompatLogger,
): Promise<Map<string, InjectableAgentConfig>> {
	const dirs = [
		path.join(os.homedir(), ".claude", "agents"),
		path.join(worktree, ".claude", "agents"),
	]

	const staged = new Map<string, InjectableAgentConfig>()
	for (const dir of dirs) {
		let entries: string[]
		try {
			entries = await fs.readdir(dir)
		} catch {
			continue
		}
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".md")) continue
			const filePath = path.join(dir, entry)
			try {
				const parsed = await parseAgentFile(filePath)
				if (!parsed) {
					report.skipped.push(`${filePath} (empty body or unusable name)`)
					continue
				}
				staged.set(parsed.name, parsed.config)
			} catch (error) {
				report.skipped.push(`${filePath} (${error instanceof Error ? error.message : "unreadable"})`)
				log.warn(`claude-compat: failed to parse agent file ${filePath}`)
			}
		}
	}

	return staged
}

export function commandNameFromRelativePath(relativePath: string): string {
	const withoutExtension = relativePath.slice(0, -3)
	return withoutExtension.split(path.sep).join(":")
}

interface ParsedCommandFile {
	name: string
	config: InjectableCommandConfig
}

async function parseCommandFile(filePath: string, name: string): Promise<ParsedCommandFile | null> {
	const content = await fs.readFile(filePath, "utf8")
	const { data, body } = parseFrontmatter(content)

	const template = body.trim()
	if (!template) return null

	const firstLine = template.split("\n").find((line) => line.trim().length > 0) ?? name
	let description = data.description || firstLine.slice(0, 80)
	if (data["argument-hint"]) {
		description += ` (args: ${data["argument-hint"]})`
	}

	const config: InjectableCommandConfig = { template, description }
	const model = mapClaudeModel(data.model)
	if (model) config.model = model
	if (data.agent) config.agent = data.agent

	return { name, config }
}

async function walkCommandFiles(
	dir: string,
	baseDir: string,
	depth: number,
	found: Array<{ filePath: string; name: string }>,
): Promise<void> {
	if (depth > MAX_COMMAND_DEPTH) return
	let entries: Array<{ name: string; isDirectory(): boolean }>
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const entryPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			await walkCommandFiles(entryPath, baseDir, depth + 1, found)
		} else if (entry.name.endsWith(".md")) {
			found.push({
				filePath: entryPath,
				name: commandNameFromRelativePath(path.relative(baseDir, entryPath)),
			})
		}
	}
}

/**
 * Discover .claude/commands/**\/*.md slash commands. Subdirectories namespace
 * with ":" (foo/bar.md becomes /foo:bar), matching Claude Code.
 */
export async function collectClaudeCommands(
	worktree: string,
	report: CompatReport,
	log: CompatLogger,
): Promise<Map<string, InjectableCommandConfig>> {
	const dirs = [
		path.join(os.homedir(), ".claude", "commands"),
		path.join(worktree, ".claude", "commands"),
	]

	const staged = new Map<string, InjectableCommandConfig>()
	for (const dir of dirs) {
		const found: Array<{ filePath: string; name: string }> = []
		await walkCommandFiles(dir, dir, 0, found)
		for (const { filePath, name } of found) {
			try {
				const parsed = await parseCommandFile(filePath, name)
				if (!parsed) {
					report.skipped.push(`${filePath} (empty template)`)
					continue
				}
				staged.set(parsed.name, parsed.config)
			} catch (error) {
				report.skipped.push(`${filePath} (${error instanceof Error ? error.message : "unreadable"})`)
				log.warn(`claude-compat: failed to parse command file ${filePath}`)
			}
		}
	}

	return staged
}

/**
 * Lint skills for opencode's silent-rejection rules: the SKILL.md frontmatter
 * name must exist and exactly match its directory name, and a description is
 * required for the skill to be advertised. Discovery itself is native; this
 * only surfaces why a skill might be invisible.
 */
export async function lintSkills(
	worktree: string,
	report: CompatReport,
	log: CompatLogger,
): Promise<void> {
	const skillRoots = [
		path.join(worktree, ".claude", "skills"),
		path.join(os.homedir(), ".claude", "skills"),
	]
	for (const root of skillRoots) {
		let entries: string[]
		try {
			entries = await fs.readdir(root)
		} catch {
			continue
		}
		for (const dirName of entries) {
			const skillPath = path.join(root, dirName, "SKILL.md")
			let content: string
			try {
				content = await fs.readFile(skillPath, "utf8")
			} catch {
				continue
			}
			const { data } = parseFrontmatter(content)
			if (!data.name) {
				report.skipped.push(`${skillPath} (missing frontmatter name; opencode will reject it)`)
				log.warn(`claude-compat: skill ${skillPath} has no frontmatter name and will be ignored`)
			} else if (data.name !== dirName) {
				report.skipped.push(
					`${skillPath} (frontmatter name "${data.name}" != directory "${dirName}"; opencode will reject it)`,
				)
				log.warn(
					`claude-compat: skill ${skillPath} name "${data.name}" does not match its directory "${dirName}" and will be ignored by opencode`,
				)
			} else if (!data.description) {
				report.skipped.push(`${skillPath} (missing description; skill will not be advertised)`)
				log.warn(`claude-compat: skill ${skillPath} has no description and will not be advertised`)
			}
		}
	}
}

/**
 * Apply everything to the mutable config. Returns the report for logging.
 */
export async function applyClaudeCompat(
	config: MutableConfig,
	worktree: string,
	log: CompatLogger,
): Promise<CompatReport> {
	const report: CompatReport = { instructions: [], agents: [], commands: [], skipped: [] }

	// opencode resolves relative `instructions` entries against the project,
	// not the config dir, so the harness philosophy file must be injected with
	// an absolute path to load at all.
	const philosophyPath = path.join(os.homedir(), ".opencode", "tools", "philosophy.md")
	if (await fileExists(philosophyPath)) {
		const existing = new Set((config.instructions ?? []).map((entry) => path.resolve(entry)))
		if (!existing.has(philosophyPath)) {
			config.instructions = [...(config.instructions ?? []), philosophyPath]
			report.instructions.push(philosophyPath)
		}
	}

	const instructions = await collectClaudeInstructions(
		worktree,
		report,
		log,
		config.instructions ?? [],
	)
	if (instructions.length > 0) {
		config.instructions = [...(config.instructions ?? []), ...instructions]
	}

	const agents = await collectClaudeAgents(worktree, report, log)
	if (agents.size > 0) {
		config.agent = config.agent ?? {}
		for (const [name, agentConfig] of agents) {
			if (name in config.agent) {
				report.skipped.push(`.claude agent "${name}" (collides with an existing agent)`)
				log.warn(`claude-compat: skipping .claude agent "${name}" (name already defined)`)
				continue
			}
			config.agent[name] = agentConfig
			report.agents.push(name)
		}
	}

	await lintSkills(worktree, report, log)

	const commands = await collectClaudeCommands(worktree, report, log)
	if (commands.size > 0) {
		config.command = config.command ?? {}
		for (const [name, commandConfig] of commands) {
			if (name in config.command) {
				report.skipped.push(`.claude command "${name}" (collides with an existing command)`)
				log.warn(`claude-compat: skipping .claude command "${name}" (name already defined)`)
				continue
			}
			config.command[name] = commandConfig
			report.commands.push(name)
		}
	}

	return report
}
