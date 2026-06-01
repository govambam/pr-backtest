# Adversarial review pass — synthesis & resolutions

Three `general-purpose` subagents reviewed `validation-contract.md` (v1) against the spec. Consensus findings and how the v2 contract resolves them:

| # | Finding (consensus) | Resolution in v2 |
|---|---|---|
| 1 | **Gap:** §4.1 default-view start/`✓` completion markers were asserted only for git ops; the general `step()` upgrade was uncovered. | Added **VAL-CH-003** (default view shows start + completion markers via upgraded `index.ts` step sites). |
| 2 | **Gap:** VAL-SAFE-001 passed trivially — token absent by construction, never proving `redact()` runs. | Strengthened VAL-SAFE-001: part (b) forces a sentinel-bearing string through a trace line and asserts it is scrubbed to `***`. |
| 3 | **Overlap:** VAL-API-001 ("records …") vs VAL-API-003 (print gating). | VAL-API-001 scoped to installation locus + fires-once; VAL-API-003 owns printed content/gating. |
| 4 | **Overlap:** VAL-CH-001 vs VAL-API-003 / VAL-SAFE-001 on "trace on stderr / default prints none." | VAL-CH-001 scoped to channel only; VAL-SAFE-001 scoped to token-absence only. |
| 5 | **Ambiguous:** VAL-API-004 host comparison (Enterprise/baseUrl/media hosts). | Pinned to "compare vs configured base host `api.github.com`; fabricated foreign host throws"; noted tool issues no uploads/codeload. |
| 6 | **Unrunnable grep:** VAL-API-002 "no bare `new Octokit`" — injection seam legitimately keeps one. | Rephrased: grep for the `makeOctokit` import + default-path usage; test exercises the injection seam. |
| 7 | **`-v` collision:** `-v` already bound to `--version`. | VAL-CH-002 now asserts `--verbose` does not reassign `-v`. |
| 8 | **Untestable phrasing:** VAL-GIT-003 "no animation frames / no spinner library." | Moved the "no spinner / no new dep" half to VAL-GATE-003; VAL-GIT-003 keeps the `\r`/single-line assertion and pins the renderer to `log.ts`. |
| 9 | **Under-proof:** VAL-SAFE-002 failure path didn't prove raw stderr suppressed. | Now uses a sentinel on the fake git's stderr that must never appear in user-facing output. |
| 10 | **Unverifiable "before/after":** VAL-SAFE-003. | Pinned the expected op sequence (transcribed from base `runBacktest`) + at least one failure exit path. |
| 11 | **Weak gate:** VAL-API-003 elapsed-unit ambiguity (ms vs s). | Fixed format to `<N>ms` for API lines. |
| 12 | **GATE-004 manual can't auto-pass.** | Acknowledged: `manual` → `blocked`; the `grep` is the automatable portion. |

Result: 17 assertions across 5 areas, each claimed exactly once (see `features.json` + coverage-check).
