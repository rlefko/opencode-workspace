# opencode-workspace

A personal OpenCode harness tuned to feel like Claude Code on local LM Studio
models. Forked from [kdcokenny/opencode-workspace](https://github.com/kdcokenny/opencode-workspace)
(itself built on [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode));
heavily reworked for two tiers of local models with 262k context.

## What you get

- **Claude Code style agents.** `build` is the primary engineer: it edits,
  runs commands, tracks todos, and delegates only for parallelism. `plan` is
  read-only plan mode: explore, ask, save a plan, hand off to build.
- **Two model tiers with load management.** The 27b dense model handles
  build, plan, coder, and compaction; the 35b MoE handles everything else.
  A cross-process scheduler caps concurrent background generations (1 top,
  3 fast by default) with FIFO queueing, so parallel agents never stampede
  one LM Studio server. Foreground typing is never queued.
- **No arbitrary timeouts.** Delegations have no wall-clock limit by default.
  The only kill switch is an inactivity watchdog: a subagent is reaped only
  when it streams nothing AND runs no tool for 15 minutes straight.
- **A `workflow` tool** modeled on Claude Code's: orchestrators run small
  JavaScript scripts with `agent()`, `parallel()`, `pipeline()`, `phase()`,
  and `log()` helpers, with schema-validated structured outputs, journaling,
  and abort propagation. A `deep-research` workflow ships in `workflows/`
  (scope, parallel search fan-out, adversarial verification, cited synthesis)
  and is exposed as `/research`.
- **Claude Code project compatibility.** CLAUDE.md is always loaded (even
  when AGENTS.md exists), `.claude/agents/*.md` become subagents with models
  mapped to the local tiers, `.claude/commands/**/*.md` become slash commands
  (`foo/bar.md` is `/foo:bar`), and `.claude/skills/` works natively.
- **Pre-commit review fan-outs.** Build rules mandate honoring project
  instructions like "run reuse/simplification/readability/performance/feel
  subagents before committing" by fanning out parallel reviewer delegations.
- **Delegation reliability fixes.** Reasoning-model output is never dropped
  (text-part fallback chain), `delegation_read` never blocks for minutes,
  `delegation_cancel` stops queued or running work, `agents_status` shows
  machine-wide slot occupancy, and the per-delegation metadata LLM call is
  off by default.

## Layout

The repo mirrors `~/.opencode` one to one:

```
opencode.jsonc      # provider, model tiers, agents, permissions
harness.jsonc       # scheduler tiers, caps, timeout policy
plugins/            # workspace, background-agents, workflow, claude-compat,
                    # notify, worktree, kdco-primitives, lib/
agents/             # coder, researcher, reviewer, scribe prompts
commands/           # /review, /research
skills/             # code-philosophy, code-review, frontend-philosophy,
                    # plan-protocol, plan-review
workflows/          # deep-research.js (saved workflow)
tools/              # philosophy.md (global instructions)
scripts/install.sh  # deploy to ~/.opencode
```

## Install

```bash
scripts/install.sh --dry-run   # preview changes
scripts/install.sh             # copy into ~/.opencode with timestamped backups
scripts/install.sh --link      # symlink managed dirs to this repo (live dev)
```

Only the managed set (`plugins`, `agents`, `commands`, `skills`, `tools`,
`workflows`, `opencode.jsonc`, `harness.jsonc`, `package.json`) is touched.
`opencode.jsonc` is replaced with backup: this repo is the canonical config.
Anything replaced lands in `~/.opencode/.backups/<timestamp>/`.

If you previously launched through an OCX profile (`ocx oc -p ws`), retire it
or reinstall there too; the old profile carries a 15-minute delegation
timeout.

## Models and tiers

| Tier | Model | Used by | Cap |
|------|-------|---------|-----|
| top  | `lmstudio/qwen/qwen3.6-27b` | build, plan, coder, compaction | 1 concurrent background |
| fast | `lmstudio/qwen/qwen3.6-35b-a3b` | explore, researcher, reviewer, scribe, general, scout, title, small_model | 3 concurrent background |

Both models are configured for 262k context and 32k output. Any delegation or
workflow agent can override its model per call
(`delegate(prompt, agent, "lmstudio/qwen/qwen3.6-27b")`), and the override is
scheduled under the right tier. Caps are shared across every opencode process
on the machine via lease files in
`~/.local/share/opencode/workspace/scheduler/`. Tune everything in
`harness.jsonc` (a project can override any key with its own
`.opencode/harness.jsonc`).

## Workflow tool

```
workflow script="
  phase('review')
  const dims = ['reuse', 'simplification', 'readability', 'performance']
  const results = await parallel(dims.map(d => () =>
    agent('Review the current git diff for ' + d + ' issues only. Cite file:line.',
          {agent: 'reviewer', label: d})))
  return results.filter(Boolean).join('\n\n---\n\n')
"
```

Saved workflows resolve from `.opencode/workflows/` and `.claude/workflows/`
(project first, then global): `workflow name="deep-research" args="<question>"`,
or just `/research <question>`. Runs journal to
`~/.local/share/opencode/workflows/<project>/<run>/journal.jsonl`.

## Claude Code compatibility notes

Loaded automatically: `CLAUDE.md` (root, `.claude/`, and `~/.claude/`),
`.claude/agents/`, `.claude/commands/`, `.claude/skills/` (native).
Model aliases map opus/sonnet to the top tier and haiku to the fast tier.
Deliberately not supported: `.claude/settings.json` hooks and `allowed-tools`
enforcement (no OpenCode equivalent).

## Development

```bash
bun install
bun test plugins        # scheduler, delegation, workflow, compat tests
bunx tsc --noEmit       # strict typecheck
scripts/install.sh --link
```

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with
[OpenCode](https://github.com/sst/opencode) in any way.

## License

MIT
