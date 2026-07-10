import { describe, expect, test } from "bun:test"
import { extractJson, validateAgainstSchema } from "./structured-output"

describe("extractJson", () => {
	test("parses a fenced json block", () => {
		const result = extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.')
		expect(result).toEqual({ ok: true, value: { a: 1 } })
	})

	test("parses an unlabeled fenced block", () => {
		const result = extractJson('```\n{"list": [1, 2]}\n```')
		expect(result).toEqual({ ok: true, value: { list: [1, 2] } })
	})

	test("parses prose-wrapped braces with nested strings", () => {
		const result = extractJson(
			'The answer is {"title": "a {tricky} \\"quote\\"", "n": 2} as requested.',
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toEqual({ title: 'a {tricky} "quote"', n: 2 })
		}
	})

	test("parses a bare array", () => {
		const result = extractJson('[1, 2, 3]')
		expect(result).toEqual({ ok: true, value: [1, 2, 3] })
	})

	test("skips an unbalanced brace and finds the later object", () => {
		const result = extractJson('broken { not json... but {"ok": true} works')
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.value).toEqual({ ok: true })
	})

	test("reports failure on garbage", () => {
		const result = extractJson("no json here at all")
		expect(result.ok).toBe(false)
	})
})

describe("validateAgainstSchema", () => {
	const schema = {
		type: "object",
		required: ["files"],
		properties: {
			files: { type: "array", items: { type: "string" } },
			count: { type: "integer" },
		},
	}

	test("accepts a conforming object", () => {
		expect(validateAgainstSchema({ files: ["a.ts"], count: 1 }, schema)).toEqual({ ok: true })
	})

	test("rejects a missing required property", () => {
		const result = validateAgainstSchema({ count: 1 }, schema)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.errors[0]).toContain('missing required property "files"')
	})

	test("rejects wrong item types", () => {
		const result = validateAgainstSchema({ files: [42] }, schema)
		expect(result.ok).toBe(false)
	})

	test("integer accepts whole numbers and number accepts integers", () => {
		expect(validateAgainstSchema(3, { type: "integer" }).ok).toBe(true)
		expect(validateAgainstSchema(3, { type: "number" }).ok).toBe(true)
		expect(validateAgainstSchema(3.5, { type: "integer" }).ok).toBe(false)
	})

	test("enum matching", () => {
		expect(validateAgainstSchema("a", { enum: ["a", "b"] }).ok).toBe(true)
		expect(validateAgainstSchema("c", { enum: ["a", "b"] }).ok).toBe(false)
	})
})
