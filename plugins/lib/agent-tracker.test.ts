import { describe, expect, test } from "bun:test"
import { rememberSessionAgent, resolveSessionAgent } from "./agent-tracker"

describe("agent-tracker", () => {
	test("prefers an explicit agent over the cache", () => {
		rememberSessionAgent("ses-1", "build")
		expect(resolveSessionAgent({ agent: "plan", sessionID: "ses-1" })).toBe("plan")
	})

	test("falls back to the recorded agent for the session", () => {
		rememberSessionAgent("ses-2", "build")
		expect(resolveSessionAgent({ sessionID: "ses-2" })).toBe("build")
	})

	test("returns undefined for unknown sessions and ignores partial records", () => {
		rememberSessionAgent(undefined, "build")
		rememberSessionAgent("ses-3", undefined)
		expect(resolveSessionAgent({ sessionID: "ses-3" })).toBeUndefined()
		expect(resolveSessionAgent({})).toBeUndefined()
	})

	test("latest agent wins for a session", () => {
		rememberSessionAgent("ses-4", "build")
		rememberSessionAgent("ses-4", "plan")
		expect(resolveSessionAgent({ sessionID: "ses-4" })).toBe("plan")
	})

	test("prunes oldest entries beyond the cap", () => {
		for (let i = 0; i < 520; i++) {
			rememberSessionAgent(`bulk-${i}`, "build")
		}
		expect(resolveSessionAgent({ sessionID: "bulk-0" })).toBeUndefined()
		expect(resolveSessionAgent({ sessionID: "bulk-519" })).toBe("build")
	})
})
