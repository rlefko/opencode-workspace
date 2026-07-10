---
description: Deep research with parallel searches, adversarial verification, and a cited report
---

Run the saved deep-research workflow for the question below.

Call the `workflow` tool with:
- name: "deep-research"
- args: the research question exactly as given

When the workflow completes, present the returned report to the user unchanged
(do not summarize it away), then offer to dig deeper on any open questions it
lists.

If the question below is empty, ask the user what they want researched instead
of running the workflow.

Research question: $ARGUMENTS
