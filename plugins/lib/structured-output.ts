/**
 * structured-output
 * Prompt-embedded JSON schema support for local models. LM Studio's OpenAI
 * compatibility layer offers no forced tool-calling here, so schemas ride the
 * prompt and results are extracted and validated leniently but checked hard.
 */

export function buildSchemaInstruction(schema: object): string {
	return [
		"",
		"---",
		"OUTPUT FORMAT REQUIREMENT:",
		"Respond with ONLY a single JSON value that matches this JSON Schema.",
		"No prose before or after. A fenced ```json block is acceptable.",
		"",
		JSON.stringify(schema, null, 2),
	].join("\n")
}

export type ExtractResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Pull the first parseable JSON value out of model output. Tries, in order:
 * fenced ```json blocks, any fenced block, then a string-aware brace/bracket
 * balance scan from each opening character.
 */
export function extractJson(text: string): ExtractResult {
	const candidates: string[] = []

	const fencedJson = text.match(/```json\s*\n?([\s\S]*?)```/i)
	if (fencedJson?.[1]) candidates.push(fencedJson[1].trim())

	const fencedAny = text.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/)
	if (fencedAny?.[1]) candidates.push(fencedAny[1].trim())

	// Objects before arrays: prose like "findings [1] show {...}" contains a
	// balanced "[1]" that would otherwise win over the real payload.
	candidates.push(...scanBalancedCandidates(text, "{"))
	candidates.push(...scanBalancedCandidates(text, "["))

	const trimmed = text.trim()
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed)

	const errors: string[] = []
	for (const candidate of candidates) {
		try {
			return { ok: true, value: JSON.parse(candidate) }
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error))
		}
	}

	return {
		ok: false,
		error:
			candidates.length === 0
				? "No JSON object or array found in the output"
				: `Found ${candidates.length} JSON candidate(s) but none parsed: ${errors.join("; ")}`,
	}
}

const MAX_BALANCED_CANDIDATES = 8

function scanBalancedCandidates(text: string, open: "{" | "["): string[] {
	const close = open === "{" ? "}" : "]"
	const found: string[] = []

	for (let start = 0; start < text.length && found.length < MAX_BALANCED_CANDIDATES; start++) {
		if (text[start] !== open) continue

		let depth = 0
		let inString = false
		let escaped = false
		for (let i = start; i < text.length; i++) {
			const ch = text[i]
			if (escaped) {
				escaped = false
				continue
			}
			if (ch === "\\") {
				if (inString) escaped = true
				continue
			}
			if (ch === '"') {
				inString = !inString
				continue
			}
			if (inString) continue
			if (ch === open) depth++
			else if (ch === close) {
				depth--
				if (depth === 0) {
					found.push(text.slice(start, i + 1))
					// Skip past this candidate; nested opens inside it were part of it.
					start = i
					break
				}
			}
		}
	}
	return found
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

interface LiteSchema {
	type?: string | string[]
	required?: string[]
	properties?: Record<string, LiteSchema>
	items?: LiteSchema
	enum?: unknown[]
}

/**
 * Lite JSON Schema validator: type, required, properties (recursive), items,
 * enum. Unknown keywords are ignored; $ref/oneOf/allOf are not supported.
 */
export function validateAgainstSchema(value: unknown, schema: object): ValidationResult {
	const errors: string[] = []
	validateNode(value, schema as LiteSchema, "$", errors)
	return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

function jsonType(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
	return typeof value
}

function typeMatches(actual: string, expected: string): boolean {
	if (expected === actual) return true
	return expected === "number" && actual === "integer"
}

function validateNode(value: unknown, schema: LiteSchema, pathLabel: string, errors: string[]): void {
	if (!schema || typeof schema !== "object") return

	if (schema.enum && !schema.enum.some((allowed) => deepEquals(allowed, value))) {
		errors.push(`${pathLabel}: value is not one of the allowed enum values`)
		return
	}

	if (schema.type) {
		const actual = jsonType(value)
		const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
		if (!expected.some((t) => typeMatches(actual, t))) {
			errors.push(`${pathLabel}: expected type ${expected.join(" | ")}, got ${actual}`)
			return
		}
	}

	if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				errors.push(`${pathLabel}: missing required property "${key}"`)
			}
		}
		for (const [key, childSchema] of Object.entries(schema.properties)) {
			if (key in record) {
				validateNode(record[key], childSchema, `${pathLabel}.${key}`, errors)
			}
		}
	} else if (schema.required && value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		for (const key of schema.required) {
			if (!(key in record)) {
				errors.push(`${pathLabel}: missing required property "${key}"`)
			}
		}
	}

	if (schema.items && Array.isArray(value)) {
		value.forEach((item, index) => {
			validateNode(item, schema.items as LiteSchema, `${pathLabel}[${index}]`, errors)
		})
	}
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true
	try {
		return JSON.stringify(a) === JSON.stringify(b)
	} catch {
		return false
	}
}
