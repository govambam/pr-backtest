# Validator synthesis — pr-backtest-v0

**Verdict:** pass

**Assertions:** 47 passed, 0 failed, 4 blocked, total 51

All evidence-runnable assertions pass. The build is clean (`npm run build` exits 0, emits `dist/`), the full test suite is 36 passed / 1 skipped (the gated integration test) / 0 failed, and every grep-based behavior was confirmed by reading the surrounding code — not just by literal match. The four blocked assertions are all `manual(...)` per the contract (live GitHub flows, global install, security read-through) and cannot be executed by an offline validator.

## Failures
- None.

## Blocked (need human verification)
- VAL-PKG-010 — manual(npm install -g . then `pr-backtest --help`). Global install cannot be performed offline. bin/pr-backtest wrapper and package.json `bin` mapping are present and correct, so the manual step is expected to succeed.
- VAL-TEST-003 — manual(run test/integration.test.ts with GITHUB_TOKEN set). The test exists, is gated on GITHUB_TOKEN (skips cleanly without it), and honors TEST_FIXTURE_REPO. The token-gated end-to-end body cannot run here.
- VAL-CROSS-001 — manual(end-to-end smoke per SPEC §8). Requires a live push-access repo. Code path (plan -> push base/head -> create PR -> stdout URL -> exit 0; existing-PR -> exit 4) is fully wired in index.ts.
- VAL-CROSS-002 — manual(security read-through). Spot check found NO path where the token value reaches a log/console/stdout/stderr sink. The token flows only to writeConfig (0600 file) and into the HTTPS clone URL (buildCloneUrl), which index.ts deliberately never logs (logs redactedRepoRef instead). Strongly supports a pass on human review.

## Stack-rule findings
- **Dependencies:** `dependencies` key set equals exactly {@octokit/rest, chalk, commander, prompts, simple-git}. No telemetry/analytics/error-reporting deps. devDeps minimal and reasonable: @types/node, @types/prompts, tsx, typescript.
- **No `: any`, no `@ts-ignore`** anywhere in `src/` (both at file level and in the diff).
- **No direct network** outside Octokit/simple-git. The only `fetch(` in `src/` is `git.fetch("origin", sha)` in src/git.ts:108 — the ALLOWED simple-git method, not a global fetch / node-fetch / axios / got / https.request. PKG-002 passes.
- **No checkout / no amend / no rebase** in src/git.ts; clone uses `--no-checkout`. main is never a push target.
- **No comment-back:** no `createComment` / `issues.create` in src/github.ts (VAL-GH-004).
- **strict: true** in tsconfig.json; NodeNext ESM.
- **9 feature commits** present on the branch; working tree clean; diff non-empty (24 non-mission files, 3470 insertions).
- **AUTH-010 note:** the literal `gh auth token` appears in a doc comment (auth.ts:116); the behavior is implemented via `execFileAsync("gh", ["auth", "token"])` (auth.ts:139) gated behind a confirm prompt. Real, not a stub.

## Recommendations
None blocking. Optional, for human reviewers only:
1. Run the four manual gates (VAL-PKG-010 global install, VAL-TEST-003 token-gated integration, VAL-CROSS-001 live smoke, VAL-CROSS-002 security read-through) before publishing.
