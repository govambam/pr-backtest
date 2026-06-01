# Mission plan — sandbox-destination

**Spec:** `specs/sandbox-destination.md`
**Base branch:** `feat/fork-target` (current working branch)
**Generated:** 2026-06-01

## Contract summary

34 assertions across 9 areas (30 from spec §13 `AC-*`, renamed `VAL-*`; +4 added in adversarial review: VAL-DEST-007, VAL-CLI-002, VAL-INV-004, and the auth.ts clause in VAL-GATE-003).

| Area | Count |
|---|---|
| Destination resolution (DEST) | 7 |
| Interactive selection (INT) | 3 |
| Sandbox creation (CREATE) | 4 |
| Verification / drift (VERIFY) | 5 |
| Config persistence (CONFIG) | 4 |
| Plan & CLI surface (PLAN/CLI) | 4 |
| Invariants (INV) | 4 |
| Quality gates (GATE) | 3 |

Two assertions are `manual`/blocked (need a real GitHub run): **VAL-CREATE-003** (PR opens in a freshly created sandbox) and the README-read half of **VAL-GATE-003**.

## Features (execution order — top-down, sequential)

| # | id | fulfills | worker |
|---|---|---|---|
| 1 | config-destination | CONFIG-001..004 | worktree off `feat/fork-target` |
| 2 | destination-resolve | DEST-001,002,004,005,006,007; VERIFY-001..005; INV-001 | worktree |
| 3 | sandbox-create | CREATE-001..004; INV-002 | worktree |
| 4 | interactive-menu | INT-001..003 | worktree |
| 5 | cli-and-index | CLI-001,002; DEST-003; INV-003,004 | worktree |
| 6 | plan-and-docs | PLAN-001,002; GATE-001,002,003 | worktree |

Features are dependency-ordered and run **sequentially** — each builds on the prior (config → resolver → create/menu → CLI wiring → plan/docs). No parallelism; the chain is fully serial.

## Execution mode

- One worker per feature, each in an isolated git worktree off `feat/fork-target`.
- Workers run sequentially; after each, the orchestrator reads the handoff and updates `features.json` status.
- After all six complete, a fresh `code-reviewer` validator checks every assertion against the cumulative diff and writes `validation-state.json` + `validator-synthesis.md`.

## Key design decisions encoded in the contract

- **Pure resolver pattern** (mirrors `auth.ts:resolveTokenSource`) so precedence, verification call-order, and "source never written" are unit-testable without network/TTY. Numeric exit codes stay owned by `index.ts`; `test/cli.test.ts` is a subprocess harness for the few real-exit-code cases.
- **§10 item 6 decision:** `--create-sandbox` without `--sandbox` is a **no-op** (documented), matching the §4.3 flag table — not a bad-args error.
- **`lint-clean` = `tsc-clean`:** the project has no separate linter; tsc strict is the only static gate.

## Out of scope (will not be touched)

- Forking (no fork creation/detection; `--fork` removed entirely, no deprecation alias).
- Installing/configuring a review bot on the sandbox.
- Multiple saved destinations (exactly one default).
- Mirroring source repo settings; deleting/cleaning up sandboxes or backtest branches.
- `resolveCommit`, token resolution (`auth` mechanics), and the exit-code contract beyond §9 additions.
- §10 item 4c runtime path (sandbox-only token failing to read a private source) — existing 404 handling; only the token guidance is new.

## Risks / open questions

- **Empty-init vs minimal-commit sandbox** is left to the implementer and gated ONLY by the manual VAL-CREATE-003 — no automated coverage of created-repo usability. The sandbox-create worker must verify a backtest PR can open in whatever it creates.
- **Stale `test/plan.fork.test.ts`** asserts the old `--fork` plan wording (`Into:`, `(fork — …)`). It will break once that wording is replaced; the plan-and-docs worker must migrate or remove it.
- Two `manual` assertions can't be closed by the validator; they'll surface as `blocked` and need a human GitHub run to fully sign off.
