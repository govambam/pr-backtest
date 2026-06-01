# Mission plan — live-activity-trace

**Spec:** `specs/live-activity-trace.md`
**Base branch:** `feat/fork-target` (current working branch)
**Generated:** 2026-06-01

## Contract summary

17 assertions across 5 areas. Coverage gate: **OK — each claimed exactly once.**

| Area | Count | IDs |
|---|---|---|
| API tracing | 4 | VAL-API-001..004 |
| Git tracing | 3 | VAL-GIT-001..003 |
| Verbosity & channel | 3 | VAL-CH-001..003 |
| Safety | 3 | VAL-SAFE-001..003 |
| Quality gates | 4 | VAL-GATE-001..004 |

Contract was hardened by a three-agent adversarial review (see `adversarial-review-notes.md`): added VAL-CH-003 (default-view completion markers), strengthened VAL-SAFE-001 to actually prove the `redact()` net, de-overlapped API/CH/SAFE, pinned the host check and the `-v`/`--version` collision, and made the git-failure-path stderr suppression provable.

## Features (execution order, top-down)

| # | id | fulfills | worker |
|---|---|---|---|
| 1 | `trace-core` | — (foundational renderer in `log.ts`) | worktree off `feat/fork-target` |
| 2 | `api-hook` | VAL-API-001, -002, -003, -004 | worktree off `feat/fork-target` |
| 3 | `git-trace` | VAL-GIT-001, -002, -003, VAL-SAFE-002 | worktree off `feat/fork-target` |
| 4 | `wire-and-docs` | VAL-CH-001, -002, -003, VAL-SAFE-001, -003, VAL-GATE-001, -002, -003, -004 | worktree off `feat/fork-target` |

`trace-core` is foundational (`"fulfills": []`) — its renderer primitives are exercised by the assertions later features complete.

## Execution mode

- Workers run **sequentially**, one feature at a time, each in an isolated git worktree off `feat/fork-target`. The order is dependency-driven: `trace-core` ships the renderer everything else calls; `api-hook` and `git-trace` both build on it; `wire-and-docs` integrates the flag, the default-view markers, the README, and the full-flow tests.
- `api-hook` and `git-trace` touch disjoint files (`github.ts`/`auth.ts` vs `git.ts`) and could in principle run in parallel, but both extend `log.ts`'s trace surface and share `test/trace.test.ts`, so sequential avoids merge friction.
- Model: workers inherit the session model (Opus 4.8). Subagent type: `general-purpose`.
- After all four complete, a fresh `code-reviewer` validates against the contract and writes `validator-synthesis.md` + updates `validation-state.json`.

## Out of scope (will not be touched)

- Any change to operations, ordering, write targets, or exit codes (pure observability — INV-NO-BEHAVIOR-CHANGE).
- Frame-animated spinners / spinner libraries; any new runtime dependency (INV-NO-DEP).
- Streaming raw git stderr/stdout (INV-NO-RAW-GIT-STDERR).
- Machine-readable trace format (JSON logs); tracing anything on stdout (stdout stays exactly the PR URL).

## Risks / open questions

- **No linter configured.** VAL-GATE-002 (`lint-clean`) has no command to run; the validator will mark it `blocked` ("tsc strict is the de-facto gate"). This is expected, not a failure.
- **Verbose state threading.** `makeOctokit` and `git.ts` need to know whether `--verbose` is on. The cleanest fit for this codebase is a module-level verbose/TTY state in `log.ts` (mirroring the existing `registerSecret` module-Set pattern), set once from the CLI flag. Workers are told to prefer that over threading a flag through every signature.
- **VAL-GATE-004** is part `manual` (README prose) — the validator marks the manual half `blocked` and runs the `grep` half; a human should skim the README section.
