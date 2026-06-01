# Validator synthesis — sandbox-destination

**Verdict:** pass

**Assertions:** 32 passed, 0 failed, 2 blocked, total 34

All evidence runs were executed first-hand: `npm run build` (exit 0), the four named
test files individually, and the full suite (`npm test` → 100 pass / 1 skip / 0 fail;
the 1 skip is the network integration test, out of scope). Every grep/skeptical check
was run against the real `c424510..HEAD` mission diff (the brief's `c424514` base was a
typo; the actual base is `c424510`).

## Failures
None.

## Blocked (need human verification)
- VAL-CREATE-003 — `manual`: a backtest PR must open end-to-end in a freshly created
  throwaway private repo. `createPrivateRepo` uses `auto_init: true` (gives the new repo
  a usable default branch) which is the right choice on inspection, but only a real
  GitHub run proves created-repo usability. No automated coverage exists by design.
- VAL-GATE-003 — `manual` README-read half only. The grep half PASSES: README §
  "Destination"/"Token" documents the primary-vs-sandbox model, the read-only guarantee,
  `--primary`/`--sandbox`/`--create-sandbox`, and the two-repo token note (README:62-100),
  and `src/auth.ts:162-164` states the READ-source + WRITE-destination two-repo
  requirement. A human still needs to read the README for prose quality/accuracy.

## Stack-rule findings
- **New deps:** none. `package.json` `dependencies` is byte-for-byte the pre-mission set
  (`@octokit/rest`, `chalk`, `commander`, `prompts`, `simple-git`); only `version`
  bumped 0.1.0→0.2.0. (VAL-INV-003 ✓)
- **Token safety:** clean. The two new wrappers `verifyRepo` and `createPrivateRepo`
  (src/github.ts:240,194) both take an `Octokit` instance, never a raw token. No token is
  interpolated into any URL or git command line anywhere in `src/`; git auth flows through
  `GIT_ASKPASS` and an `x-access-token@` URL with no embedded secret (src/git.ts:95,124).
  (VAL-INV-002 ✓)
- **@ts-ignore:** zero new occurrences in the mission diff.
- **INV-READONLY:** confirmed at both levels. The resolver never passes the source to a
  verify/create/write (test/destination.test.ts assertSourceNeverWritten), and index.ts
  routes clone/push/createPullRequest/findExistingPr to `destOwner/destRepo`, with the
  source appearing only in reads and as the `source` fetch remote. (VAL-INV-001/004 ✓)
- **VAL-DEST-003 exit-1 reason (skeptical check):** the resolver-unit half is the strong
  evidence — test/destination.test.ts:110 asserts the both-flags case throws
  `DestinationArgsError` with `calls.length === 0` (rejected before any verify/create).
  The CLI subprocess half (test/cli.test.ts:75) asserts `status === 1` but, as its own
  comment admits, token resolution precedes destination resolution, so a hermetic
  no-token subprocess reaches exit 1 at the auth stage and the harness does not prove
  the both-flags guard specifically fired. This is an acknowledged harness limitation,
  not a defect — the unit half carries the assertion.

## Minor discrepancies (noted, not failing)
- **VAL-PLAN-002 grep literalism:** the contract's grep says "no `Into:`/`(fork` wording
  remaining in src/plan.ts". `(fork` is gone, but the literal token `Into:` remains
  (src/plan.ts:73) — repurposed as the sandbox header `Into: <repo> (sandbox — …)`. The
  assertion's actual intent (source not tagged read-only when dest==source; the
  fork-specific wording removed) is fully met and tested (test/plan.test.ts:52,64). Passed
  on substance; flagging the literal-token retention for the orchestrator's awareness.
- **VAL-CLI-002 missing dedicated test:** evidence line names `test(test/destination.test.ts)`,
  but no test asserts the `--create-sandbox`-without-`--sandbox` no-op branch. The code
  is correct (createSandbox is only consulted inside the `--sandbox` branch, so it is a
  true no-op) and the README documents it (README:77,79), so the assertion's substance
  holds — but the named automated coverage is absent.
- **VAL-INV-002 auth.test.ts clause:** the contract suggests extending `test/auth.test.ts`;
  that file was not modified. Coverage is instead in test/destination.test.ts (VAL-INV-002
  asserts the creator receives an octokit, not a token) plus the grep. Substance satisfied.

## Recommendations
Mission passes. The two blocked items are human/manual gates, not worker defects. Optional
hardening, in priority order, if the orchestrator wants to close the noted gaps:
1. (low) Add a dedicated `test/destination.test.ts` case for VAL-CLI-002: resolver with
   `{ createSandbox: true }` and no `sandbox` flag in a non-TTY/no-default context behaves
   identically to no flags (throws DestinationArgsError; createSandbox never called).
2. (low) Either reword the VAL-PLAN-002 contract grep to target `(fork`/`--fork` only, or
   rename the `Into:` label — purely a contract/label-alignment nicety.
3. (human) Run VAL-CREATE-003 against a throwaway private repo and confirm the auto_init
   default branch lets the backtest PR open; read the README for VAL-GATE-003.
