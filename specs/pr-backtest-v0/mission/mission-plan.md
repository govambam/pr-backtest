# Mission plan — pr-backtest-v0

**Spec:** `SPEC.md` (repo root)
**Base branch:** `main`
**Generated:** 2026-06-01

## Contract summary

51 assertions across 9 areas + cross-area flows.

| Area | Count |
|---|---|
| URL parsing | 3 |
| Commit resolution | 4 |
| Auth & config | 11 |
| GitHub API | 4 |
| Git operations | 7 |
| Plan & confirm | 3 |
| CLI / exit codes / output | 5 |
| Packaging & docs | 9 |
| Tests | 3 |
| Cross-area | 2 |

Of these, 4 are `manual` (blocked for the validator): VAL-PKG-010 (global install), VAL-TEST-003 (token-gated integration test), VAL-CROSS-001 (live e2e), VAL-CROSS-002 (token-secrecy read-through).

## Features (execution order, top-down)

| # | id | fulfills (count) | depends on |
|---|---|---|---|
| 1 | scaffold | 4 | — |
| 2 | parse-url | 4 | scaffold |
| 3 | resolve-commit | 5 | scaffold |
| 4 | config-and-auth | 11 | scaffold |
| 5 | github-api | 4 | scaffold, auth |
| 6 | git-ops | 7 | scaffold |
| 7 | plan-confirm | 3 | scaffold |
| 8 | cli-and-orchestration | 9 | 2–7 |
| 9 | readme-and-integration-test | 4 | 8 |

## Execution mode — IMPORTANT deviation from the default

This is a **greenfield, tightly-coupled** build (one ~570 LOC binary; later modules import earlier ones). The mission default — one isolated worktree per feature off `main` — does **not** fit here: an isolated worktree for `parse-url` would not contain the `scaffold` feature's `package.json`/`tsconfig`, so every worker would have to re-scaffold and modules could never import one another.

**Proposed instead:** workers run **sequentially on a single shared mission branch** (`mission/pr-backtest-v0`), each committing on top of the previous worker's commit, in the main working tree (no per-feature worktree isolation). This preserves the mission model's other guarantees (one worker per feature, fresh `code-reviewer` validator, written contract) while letting features build on each other.

## Out of scope (will not be touched)

- Anything in `reference/` (read-only, gitignored, deleted post-v0)
- Webapp/server/database/auth-service/prospector/email — explicitly excluded by SPEC §2
- Cherry-pick fallback ladder, cross-reference stripping, `@macroscope` auto-comment, fork management — SPEC §5 (and asserted as negative behaviors: VAL-GH-004, VAL-GIT-007)
- Batch backtesting, GitLab/Bitbucket — SPEC §10 post-v0

## Risks / open questions

- **Test runner not specified.** SPEC names tests but no runner. The `scaffold` worker will pick one (likely `node --test` + `tsx`, zero extra heavy deps) — flagged because it's a dev-dep decision.
- **4 manual assertions** can't be machine-validated; they'll land as `blocked` and need a human run against a real PR + a `GITHUB_TOKEN`.
- **Token-secrecy (VAL-CROSS-002)** is a read-through, not a grep — depends on the validator's diligence.
