// deep-research: scope -> parallel search fan-out -> adversarial verify -> cited synthesis.
// Mirrors Claude Code's deep-research harness on local models.
// args: the research question (string), or { question, breadth }.

const question = typeof args === "string" ? args : (args && args.question) || ""
if (!question.trim()) {
	return 'No research question provided. Run again with args="<question>".'
}
const breadth = Math.min((args && args.breadth) || 4, 6)

phase("scope")
const scope = await agent(
	"You are scoping a deep research task. Research question:\n" +
		question +
		"\n\nProduce " +
		breadth +
		" distinct research angles (sub-questions) that together cover the question. " +
		"Angles must not overlap and each must be independently searchable.",
	{
		agent: "researcher",
		label: "scope",
		schema: {
			type: "object",
			required: ["angles"],
			properties: {
				angles: {
					type: "array",
					items: {
						type: "object",
						required: ["title", "query"],
						properties: {
							title: { type: "string" },
							query: { type: "string" },
						},
					},
				},
			},
		},
	},
)
const angles = scope.angles.slice(0, breadth)
log(angles.length + " research angles scoped")

phase("search")
const findings = await parallel(
	angles.map((angle) => () =>
		agent(
			"Research this thoroughly using your web search and documentation tools (Exa, Context7, GitHub, webfetch). " +
				"Question: " +
				angle.query +
				"\n\nReturn key findings as bullet points, each with a source citation (URL or owner/repo/path). " +
				"Include exact quotes or copy-pasteable code where relevant. End with a SOURCES list.",
			{ agent: "researcher", label: "search:" + angle.title.slice(0, 24) },
		),
	),
)
const usable = findings.filter(Boolean)
log(usable.length + "/" + angles.length + " searches returned findings")
if (usable.length === 0) {
	return "All research angles failed. Check network and MCP access (Exa, Context7), then retry."
}

phase("verify")
const verified = await parallel(
	usable.map((finding, index) => () =>
		agent(
			"You are a skeptical fact-checker. Below are research findings. Identify the 2-3 most " +
				"load-bearing claims and verify each INDEPENDENTLY with your own searches (do not trust " +
				"the original source alone). For each claim reply exactly one of: CONFIRMED (with a " +
				"corroborating source), REFUTED (with counter-evidence), or UNVERIFIED (explain the gap).\n\n" +
				finding,
			{ agent: "researcher", label: "verify:" + (index + 1) },
		),
	),
)

phase("synthesize")
const report = await agent(
	"Write a deep-research report answering:\n" +
		question +
		"\n\nFINDINGS BY ANGLE:\n\n" +
		usable.join("\n\n=====\n\n") +
		"\n\nVERIFICATION RESULTS:\n\n" +
		verified.filter(Boolean).join("\n\n=====\n\n") +
		"\n\nRules: lead with a direct answer to the question; organize by theme, not by angle; " +
		"cite sources inline as [Title](url); explicitly flag any claim that came back REFUTED or " +
		"UNVERIFIED; end with remaining open questions.",
	{ agent: "researcher", model: "lmstudio/qwen/qwen3.6-27b", label: "synthesize" },
)

return report
