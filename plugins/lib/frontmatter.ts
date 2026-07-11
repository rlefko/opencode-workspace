/**
 * frontmatter
 * Minimal YAML-subset frontmatter parser for Claude Code asset files.
 * Supports a leading `---` block of scalar `key: value` lines. Nested and
 * list YAML lines are ignored; malformed frontmatter degrades to body-only.
 */

export interface ParsedFrontmatter {
	data: Record<string, string>
	body: string
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const normalized = content.replace(/\r\n/g, "\n")
	if (!normalized.startsWith("---\n")) {
		return { data: {}, body: content }
	}

	const closingIndex = normalized.indexOf("\n---", 4)
	if (closingIndex < 0) {
		return { data: {}, body: content }
	}

	const block = normalized.slice(4, closingIndex)
	const body = normalized.slice(closingIndex + 4).replace(/^\n/, "")

	const data: Record<string, string> = {}
	for (const line of block.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue
		// Skip nested/list YAML (indented lines and "- item" lines).
		if (/^\s/.test(line) || line.trim().startsWith("-")) continue
		const colonIndex = line.indexOf(":")
		if (colonIndex <= 0) continue
		const key = line.slice(0, colonIndex).trim()
		let value = line.slice(colonIndex + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1)
		}
		// A bare "key:" line introduces nested YAML; ignore it like other nesting.
		if (key && value) data[key] = value
	}

	return { data, body }
}
