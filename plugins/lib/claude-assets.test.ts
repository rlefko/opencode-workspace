import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	collectClaudeAgents,
	collectClaudeCommands,
	collectClaudeInstructions,
	commandNameFromRelativePath,
	type CompatReport,
	FAST_TIER_MODEL,
	mapClaudeModel,
	mapClaudeTools,
	TOP_TIER_MODEL,
} from "./claude-assets"
import { parseFrontmatter } from "./frontmatter"

const tmpDirs: string[] = []
const noopLog = { info: () => {}, warn: () => {} }

function makeReport(): CompatReport {
	return { instructions: [], agents: [], commands: [], skipped: [] }
}

async function makeWorktree(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-compat-test-"))
	tmpDirs.push(dir)
	return dir
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

describe("parseFrontmatter", () => {
	test("parses scalar keys and strips quotes", () => {
		const { data, body } = parseFrontmatter(
			'---\nname: tester\ndescription: "A test agent"\nmodel: haiku\n---\n\nBody text',
		)
		expect(data).toEqual({ name: "tester", description: "A test agent", model: "haiku" })
		expect(body).toBe("\nBody text")
	})

	test("treats unterminated frontmatter as body", () => {
		const { data, body } = parseFrontmatter("---\nname: broken\nno closing fence")
		expect(data).toEqual({})
		expect(body).toContain("name: broken")
	})

	test("ignores nested and list lines", () => {
		const { data } = parseFrontmatter("---\nname: x\nmeta:\n  nested: y\n- item\n---\nbody")
		expect(data).toEqual({ name: "x" })
	})
})

describe("model and tool mapping", () => {
	test("maps Claude aliases onto local tiers", () => {
		expect(mapClaudeModel("opus")).toBe(TOP_TIER_MODEL)
		expect(mapClaudeModel("sonnet")).toBe(TOP_TIER_MODEL)
		expect(mapClaudeModel("haiku")).toBe(FAST_TIER_MODEL)
		expect(mapClaudeModel("claude-haiku-4-5-20251001")).toBe(FAST_TIER_MODEL)
		expect(mapClaudeModel("inherit")).toBeUndefined()
		expect(mapClaudeModel(undefined)).toBeUndefined()
	})

	test("tools list becomes a deny-baseline permission block", () => {
		const permission = mapClaudeTools("Read, Grep, Edit")
		expect(permission).toEqual({
			edit: "allow",
			write: "deny",
			bash: { "*": "deny" },
			webfetch: "deny",
			read: "allow",
			grep: "allow",
		})
	})

	test("no tools list means inherit", () => {
		expect(mapClaudeTools(undefined)).toBeUndefined()
		expect(mapClaudeTools("  ")).toBeUndefined()
	})
})

describe("collectClaudeInstructions", () => {
	test("adds root CLAUDE.md only when AGENTS.md shadows it", async () => {
		const worktree = await makeWorktree()
		await fs.writeFile(path.join(worktree, "CLAUDE.md"), "# rules")

		// Without AGENTS.md the native fallback already loads it: skip.
		let added = await collectClaudeInstructions(worktree, makeReport(), noopLog, [])
		expect(added).toHaveLength(0)

		await fs.writeFile(path.join(worktree, "AGENTS.md"), "# agents rules")
		added = await collectClaudeInstructions(worktree, makeReport(), noopLog, [])
		expect(added).toEqual([path.resolve(path.join(worktree, "CLAUDE.md"))])
	})

	test("always adds .claude/CLAUDE.md and dedupes existing entries", async () => {
		const worktree = await makeWorktree()
		await fs.mkdir(path.join(worktree, ".claude"), { recursive: true })
		const nested = path.join(worktree, ".claude", "CLAUDE.md")
		await fs.writeFile(nested, "# nested rules")

		const first = await collectClaudeInstructions(worktree, makeReport(), noopLog, [])
		expect(first).toEqual([path.resolve(nested)])

		const second = await collectClaudeInstructions(worktree, makeReport(), noopLog, first)
		expect(second).toHaveLength(0)
	})

	test("skips oversized files", async () => {
		const worktree = await makeWorktree()
		await fs.writeFile(path.join(worktree, "AGENTS.md"), "# agents")
		await fs.writeFile(path.join(worktree, "CLAUDE.md"), "x".repeat(50 * 1024))

		const report = makeReport()
		const added = await collectClaudeInstructions(worktree, report, noopLog, [])
		expect(added).toHaveLength(0)
		expect(report.skipped[0]).toContain("too large")
	})
})

describe("collectClaudeAgents", () => {
	test("parses agents with tier mapping and permissions", async () => {
		const worktree = await makeWorktree()
		const agentsDir = path.join(worktree, ".claude", "agents")
		await fs.mkdir(agentsDir, { recursive: true })
		await fs.writeFile(
			path.join(agentsDir, "tester.md"),
			"---\nname: tester\ndescription: Runs tests\ntools: Read, Grep\nmodel: haiku\n---\n\nYou are a test runner.",
		)
		await fs.writeFile(path.join(agentsDir, "empty.md"), "---\nname: empty\n---\n\n   ")

		const report = makeReport()
		const agents = await collectClaudeAgents(worktree, report, noopLog)
		expect([...agents.keys()]).toEqual(["tester"])

		const tester = agents.get("tester")
		expect(tester?.mode).toBe("subagent")
		expect(tester?.model).toBe(FAST_TIER_MODEL)
		expect(tester?.prompt).toBe("You are a test runner.")
		expect(tester?.permission?.write).toBe("deny")
		expect(tester?.permission?.read).toBe("allow")
		expect(report.skipped.some((entry) => entry.includes("empty.md"))).toBe(true)
	})
})

describe("collectClaudeCommands", () => {
	test("namespaces nested commands with colons", async () => {
		const worktree = await makeWorktree()
		const commandsDir = path.join(worktree, ".claude", "commands", "foo")
		await fs.mkdir(commandsDir, { recursive: true })
		await fs.writeFile(
			path.join(commandsDir, "bar.md"),
			"---\ndescription: Does foo bar\nargument-hint: <target>\n---\n\nDo the thing to $ARGUMENTS",
		)

		const commands = await collectClaudeCommands(worktree, makeReport(), noopLog)
		expect([...commands.keys()]).toEqual(["foo:bar"])
		const command = commands.get("foo:bar")
		expect(command?.template).toContain("$ARGUMENTS")
		expect(command?.description).toBe("Does foo bar (args: <target>)")
	})

	test("command name mapping", () => {
		expect(commandNameFromRelativePath("bar.md")).toBe("bar")
		expect(commandNameFromRelativePath(path.join("a", "b", "c.md"))).toBe("a:b:c")
	})
})
