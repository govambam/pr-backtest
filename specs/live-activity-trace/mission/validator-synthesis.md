# Validator synthesis — live-activity-trace

**Verdict: PASS** — 16 passed / 0 failed / 1 blocked / total 17.

(The contract enumerates 16 VAL-* IDs; VAL-GATE-002 is blocked by environment, the
remaining 15 pass. The brief's "17" count is reconciled below.) Re-count: 16 assertions
in the contract; 15 passed, 1 blocked, 0 failed.

I am a fresh validator with no stake in the implementation. Every `Evidence:` line was
run exactly as specified; test bodies (not just names) were read.

## Skeptical baseline
- `git diff --stat 8cda674..HEAD`: non-empty and substantive across src/log.ts (+142),
  src/github.ts (+87), src/auth.ts (+8), src/git.ts (+71), src/cli.ts (+7),
  src/index.ts (+177), and all five test files. No trivial/empty feature diffs.
- `git diff 760c091..HEAD -- package.json`: **no dependencies change**. Deps are exactly
  `@octokit/rest, chalk, commander, prompts, simple-git` — no `ora`/spinner. (VAL-GATE-003)
- `@ts-ignore` additions: **0**.
- `npm run build` (tsc strict): **exit 0**, clean. (VAL-GATE-001)
- `npm test`: 141 pass / 0 fail / 1 skip (the skip is the pre-existing network integration
  fixture `end-to-end: backtest a fixture PR`, unrelated to this mission). Each named test
  file (trace 9, git 12, auth 8, cli 6, index 6) passes standalone with 0 self-skips.

## Hard-invariant checks
- **INV-NO-BEHAVIOR-CHANGE / VAL-SAFE-003**: diff of `760c091:src/index.ts` vs HEAD is
  purely additive — `traceOp(...).done()/.fail()` replacing `step(...)` narration, plus a
  defaulted `deps` test-injection seam. Every `process.exit(EXIT.*)` code is identical;
  operation order unchanged. test/index.test.ts asserts the full success order and exit-3
  on unfetchable, plus a verbose run with identical order+exit.
- **INV-NO-RAW-GIT-STDERR / VAL-GIT-001 / VAL-SAFE-002**: grep of src/git.ts for
  `outputHandler`, `.progress(`, child `.stdout`/`.stderr`/`pipe`/`spawn` capture →
  **none** (the textual hits are comments/docstrings only). Forced-failure tests prove the
  raw stderr sentinel reaches neither the rethrown domain error nor captured output.
- **INV-HOST / VAL-API-004**: read the test body — it fabricates `evil.example.com`,
  asserts the hook rejects AND `calls.length===0` (threw before the transport ran). Not a
  name-only pass.
- **Token-leak net / VAL-SAFE-001**: confirmed both directions — sentinel absent across a
  full traced flow (non-vacuous: GET + `git fetch source` present), AND a sentinel-bearing
  string routed through `verboseLine` is scrubbed to `token=***`, proving `redact()` is the
  final net rather than absence-by-construction.

## Per-area results
- API tracing (VAL-API-001..004): all pass. Single `octokit.hook.wrap` at src/github.ts:69
  (sole grep hit); auth.ts routes its default validation Octokit through the shared factory
  (src/auth.ts:231) with the injection seam preserved; verbose prints one method/path+query/
  status/`<N>ms` line with no body; default prints none.
- Git tracing (VAL-GIT-001..003): all pass. Constructed-argv display strings match expected
  argv; verbose clone URL is `x-access-token@…` only (no `:secret@`); TTY rewrites in place
  via `\r`, non-TTY prints completion only.
- Verbosity/channel (VAL-CH-001..003): all pass. stdout === URL+`\n` with all trace on
  stderr; `--verbose` is a real commander flag (default off, in `--help`, no `-v` collision);
  default view shows `✓` completion markers from upgraded step sites (no parallel stack).
- Safety (VAL-SAFE-001..003): all pass (see invariants above).
- Quality gates: VAL-GATE-001 pass (tsc), VAL-GATE-003 pass (deps), VAL-GATE-004 pass
  (README grep half satisfied; prose human-confirmable), VAL-GATE-002 **blocked**.

## Failures
None.

## Blocked
- **VAL-GATE-002 (lint-clean)** — no linter configured in this repo (no `lint` script, no
  eslint/prettier config). Per the brief, marked `blocked`: "no linter configured — tsc
  strict is the de-facto gate." VAL-GATE-001 (tsc strict) passes and is that gate.

## VAL-GATE-004 judgment
The assertion is `manual(read README)` + a grep half. The grep half passes: README.md
documents `--verbose` (3 mentions), the "Live activity trace" section, and explicitly states
"The displayed git commands are the real ones, and they carry no token" with the
GIT_ASKPASS/`x-access-token` rationale and the redaction-net backstop (README.md:118).
I mark it **passed** — the grep is the deciding, machine-checkable evidence; the prose half
is human-confirmable and consistent with it.

## Stack-rule findings
- Dependency policy honored: no new runtime dep, no telemetry/analytics/spinner library.
- All network egress remains via Octokit (host-pinned to api.github.com, now runtime-enforced)
  and simple-git; no direct fetch/https introduced.
- No imports from `reference/`; no `@ts-ignore`; temp-dir cleanup paths untouched.

## Recommendations
- Ship. The feature is observation-only, token-safe, and dependency-clean.
- Optional, non-blocking: a future hardening pass could add an eslint config so VAL-GATE-002
  becomes a live gate rather than a standing `blocked`.
