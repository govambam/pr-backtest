# Validation contract — sandbox-destination

Every assertion has a stable ID and an `Evidence:` line. The validator runs the evidence to score pass/fail. Manual checks are flagged explicitly — the validator marks those `"blocked"` and surfaces them for human verification.

Source of truth for "done." Derived from `specs/sandbox-destination.md` §13 (the AC-* acceptance criteria), renamed `AC-*` → `VAL-*` so the coverage-check regex matches (1:1, area + number preserved), plus four assertions added during adversarial review to close coverage gaps: **VAL-DEST-007** (`--sandbox` == source), **VAL-CLI-002** (`--create-sandbox` without `--sandbox`), **VAL-INV-004** (duplicate-PR check targets the destination), and the auth.ts clause folded into **VAL-GATE-003**.

## Evidence vocabulary

- `tsc-clean` — `npm run build` (i.e. `tsc`) exits 0 with no type errors.
- `lint-clean` — **This project has no separate linter** (no eslint config, no `lint` script). The only static-analysis gate is `tsc --strict`, so `lint-clean` is satisfied iff `tsc-clean` holds. The validator runs `npm run build` for this and notes the absence of a dedicated linter.
- `test(<path>)` — the named test file passes under `node --import tsx --test <path>`.
- `grep(<pattern> in <path>)` — pattern matches (or must NOT match — read the assertion).
- `manual(<step>)` — human verification required (a real run against GitHub); validator marks `"blocked"`.

## Testability conventions (read before judging any exit-code or call-order assertion)

These resolve the "process.exit isn't unit-testable" and "call order isn't observable" problems:

1. **Pure resolver.** Destination resolution is implemented as a pure-ish function mirroring `auth.ts:resolveTokenSource(resolvers)` — injected getters for: parsed flags, config (`defaultDestination`), an Octokit-backed `verifyDestination`/`createSandbox`, and an interactive `prompt`. It **returns** a typed result (the resolved `{owner, repo, isSandbox}`) or **throws** a typed error carrying an intended exit class (e.g. a bad-args error → exit 1, a verification/creation failure → exit 2). Unit tests assert the returned value / thrown error kind and inspect the **recorded calls** on the injected fakes (sequence + args). This makes precedence (VAL-DEST-006), call order (VAL-VERIFY-004), and "source never written" (VAL-INV-001) observable without network or TTY.
2. **Numeric exit codes.** The `process.exit(EXIT.*)` mapping stays in `index.ts` (sole owner, per its header). Assertions phrased as "exit 1" / "exit 2" are satisfied by EITHER (a) the resolver-level typed outcome the unit test asserts, OR (b) a numeric `status` assertion in `test/cli.test.ts`, which is a **subprocess harness** (`spawnSync` of the built CLI / `tsx src/cli.ts`) for the CLI-surface cases that genuinely need the real process code. Each exit-code assertion below names which applies.
3. **Both branches.** Where an assertion covers a rule with an interactive (re-prompt) branch AND a non-interactive (exit 2) branch, its `test(...)` evidence must exercise **both** branches — a single ID passes only when both are tested. This is stated inline.

## Conventions used below

- **destination** = the repo writes (branch pushes, PR creation, repo creation) target.
- **source** = the repo the PR is read from (`owner`/`repo` parsed from the PR URL).
- "no prompt" means the injected interactive menu function is never invoked on that path.
- Menu assertions check the **choice-set identity** (which logical options appear: primary / saved-sandbox / create / different) and the presence/absence of the saved-sandbox and create rows — NOT exact label strings (the spec's §4.1 wording is a sample; label text is the implementer's).

---

## Area: Destination resolution

### VAL-DEST-001: `--primary` resolves to the source repo, no prompt
Given `--primary`, the resolver returns destination = source `owner/repo` with the sandbox flag false, and the injected prompt is never invoked.
Evidence: test(test/destination.test.ts)

### VAL-DEST-002: `--sandbox owner/repo` (existing, writable) resolves to that repo, no prompt
Given `--sandbox owner/repo` where the injected `verifyDestination` reports exists + `permissions.push === true`, the resolver returns that `owner/repo` and the prompt is never invoked.
Evidence: test(test/destination.test.ts)

### VAL-DEST-003: `--primary` and `--sandbox` together is bad-args (exit 1), no write
Passing both flags throws the bad-args outcome (→ exit 1) before any verify/clone/push/create call. No injected write/verify fake is invoked.
Evidence: test(test/destination.test.ts) for the resolver outcome + test(test/cli.test.ts) asserting subprocess `status === 1`

### VAL-DEST-004: non-interactive, no flag, no saved default → exit 1 with guidance
With no TTY, no destination flag, and no `defaultDestination`, the resolver throws the bad-args outcome (→ exit 1) and the message names both `--primary` and `--sandbox` as the fix (mirroring `NoTokenNonInteractiveError`). No write/verify fake is invoked.
Evidence: test(test/destination.test.ts) asserting the thrown error kind + message text

### VAL-DEST-005: non-interactive, no flag, saved default present → use saved default, no prompt
With no TTY, no destination flag, and a `defaultDestination`, the resolver returns the saved `owner/repo` (after verification) and the prompt is never invoked.
Evidence: test(test/destination.test.ts)

### VAL-DEST-006: resolution precedence is exactly flags → interactive(TTY) → saved-default(non-TTY) → error
A precedence table covers every branch in order: (1) an explicit flag wins over config and TTY — and `--primary`+`--sandbox` is rejected as bad-args *before* either is honored; (2) no flag + TTY → interactive prompt invoked; (3) no flag + no TTY + saved default → saved default; (4) no flag + no TTY + no default → bad-args error. `--primary` and `--sandbox` are each honored within the flag tier.
Evidence: test(test/destination.test.ts)

### VAL-DEST-007: `--sandbox` equal to the source `owner/repo` resolves as destination == source (not a sandbox)
Given `--sandbox owner/repo` whose value equals the source repo, the resolver returns destination == source with the sandbox flag false — equivalent to `--primary` (§10 item 4). Downstream `isFork`/`isSandbox` routing treats it as same-repo.
Evidence: test(test/destination.test.ts)

---

## Area: Interactive selection

### VAL-INT-001: saved-default menu offers Primary, the saved Sandbox, and "different repo"; not "create"
With a saved default and a TTY, the menu's choice set is exactly {primary, saved-sandbox, different-repo}: the saved-sandbox row is present (carrying the saved `owner/repo`) and the "create a sandbox" row is absent. Asserted on the choices passed to the injected prompt, by logical identity — not label text.
Evidence: test(test/destination.test.ts) with an injected prompt

### VAL-INT-002: no-saved-default menu offers Primary, "create a sandbox", and "different repo"; no saved row
With no saved default and a TTY, the menu's choice set is exactly {primary, create-sandbox, different-repo}: the create row is present and no saved-sandbox row appears. Asserted by logical identity on the injected prompt choices.
Evidence: test(test/destination.test.ts) with an injected prompt

### VAL-INT-003: a newly resolved non-primary, non-default destination is verified and offered as the saved default
Resolving a non-primary destination that is not already the saved default — whether via "A different repo…" (prompts for an `owner/repo` slug parsed by `parseRepoSlug`, then verified per §6) or a freshly created/selected sandbox — triggers a single "remember as default?" prompt; a "yes" persists it via the merge writer (§7). Covers §4.1 step 5.
Evidence: test(test/destination.test.ts) with an injected prompt

---

## Area: Sandbox creation

### VAL-CREATE-001: creation produces a private repo via Octokit, owner defaulting to the source owner
The injected `createSandbox` call sets the repo private (never more visible than private) and defaults the owner to the source PR's owner; it routes a personal-account owner to `repos.createForAuthenticatedUser` and an org owner to `repos.createInOrg`. Asserted on the recorded Octokit call (method chosen + `private: true` arg), not a bare grep.
Evidence: test(test/destination.test.ts) asserting the create-call method + args

### VAL-CREATE-002: creation 403 never writes the source; interactive re-prompts, non-interactive exits 2
A 403 / insufficient-permission from the creation call (a) never invokes any write against the source repo, (b) interactive: re-presents the menu (Create / different repo / primary), (c) non-interactive: throws the API-error outcome (→ exit 2) with a message naming the owner and the missing permission. Evidence MUST cover both the interactive and non-interactive branches and assert the message text.
Evidence: test(test/destination.test.ts) covering both branches + message assertion

### VAL-CREATE-003: a backtest PR opens successfully in a freshly created sandbox
End-to-end, against a throwaway private repo, `--sandbox <new> --create-sandbox -y` creates the repo and successfully opens the backtest PR in it (the created repo has a usable default branch / the open succeeds). NOTE: this `manual` check is the ONLY gate on the empty-init-vs-minimal-commit choice the spec leaves open — there is no automated coverage of created-repo usability.
Evidence: manual(create-sandbox run end to end against a throwaway private repo)

### VAL-CREATE-004: `--sandbox X --create-sandbox` creates a missing X and uses it; missing X without the flag exits 2
With `--sandbox X --create-sandbox` and X missing (verify 404), X is created and returned as the destination. With `--sandbox X` alone and X missing, the resolver throws the API-error outcome (→ exit 2) without creating anything and without writing any other repo. Evidence MUST cover both the with-flag (create) and without-flag (exit 2) branches.
Evidence: test(test/destination.test.ts) covering both branches

---

## Area: Verification / drift

### VAL-VERIFY-001: a saved default that 404s is caught pre-flight; never falls back to primary
A saved `defaultDestination` returning 404 on the verify call is detected before the clone. Interactive: the menu is re-presented (offering create / different repo). Non-interactive: throws the API-error outcome (→ exit 2). No write fake is ever called with the source/primary repo. Evidence MUST cover both branches.
Evidence: test(test/destination.test.ts) covering both branches

### VAL-VERIFY-002: a non-primary destination that exists but is not writable re-prompts / exits 2 with the §6.1 message
A non-primary destination where verify succeeds but `permissions.push !== true` produces the §6.1 write-permission message, re-prompts (interactive) or throws the API-error outcome (→ exit 2, non-interactive), and never falls back to any other repo. Evidence MUST cover both branches and assert the message names the repo + missing capability.
Evidence: test(test/destination.test.ts) covering both branches + message assertion

### VAL-VERIFY-003: primary chosen but token can't write to it → §6.1 message, not a deep git failure
Choosing the primary repo when verify reports `permissions.push !== true` produces the §6.1 write-permission message before the clone (not a downstream `pushBranchFromSha` failure), and interactively re-presents the menu rather than proceeding; non-interactive throws the API-error outcome (→ exit 2). Evidence MUST cover both branches.
Evidence: test(test/destination.test.ts) covering both branches

### VAL-VERIFY-004: the write check runs before the clone (one verify call reading `permissions.push`)
Destination verification is a single Octokit `repos.get`-style call inspecting `permissions.push`, recorded as happening after the destination is resolved and BEFORE any `cloneRepo`/`pushBranchFromSha`/`createPullRequest`. Asserted by checking the recorded call sequence on injected fakes: no clone/push/create call appears before a successful verify.
Evidence: test(test/destination.test.ts asserting call order)

### VAL-VERIFY-005: when the failing destination is the primary and a writable saved sandbox is known, §6.1 names that sandbox
When primary verification fails and a saved sandbox is known writable this run, the §6.1 message includes the bracketed clause naming that sandbox as the suggested writable alternative; when no such alternative is known, the bracketed clause is absent. Both cases asserted.
Evidence: test(test/destination.test.ts) asserting message text in both cases

---

## Area: Config persistence

### VAL-CONFIG-001: saving a default destination preserves a saved token (merge, not overwrite)
Saving a `defaultDestination` into a config that already has `token`/`username`/`source` leaves all three intact and adds the destination (read-modify-write merge, not whole-object overwrite). Asserted by reading the file back and checking all four fields.
Evidence: test(test/config.test.ts)

### VAL-CONFIG-002: saving a token preserves a saved default destination
Saving a token into a config that already has a `defaultDestination` leaves the destination intact. Asserted by reading back both the token and the destination.
Evidence: test(test/config.test.ts)

### VAL-CONFIG-003: `readConfig` tolerates legacy and destination-only files
`readConfig` returns: (a) for a legacy file with `token`/`username`/`source` and no `defaultDestination` → a Config with those three fields present and `defaultDestination` undefined; (b) for a file with a valid `defaultDestination` but no `token` → a Config exposing the destination with no token (token treated as "no saved token"). Neither case returns null or throws. Asserted on the specific fields, not just "doesn't throw."
Evidence: test(test/config.test.ts)

### VAL-CONFIG-004: the config file stays mode 0600 after a destination-only save
After saving only a `defaultDestination` (no token) into a fresh location, the file mode is exactly 0600 (the merge writer re-asserts 0600).
Evidence: test(test/config.test.ts)

---

## Area: Plan and CLI surface

### VAL-PLAN-001: destination ≠ source → plan shows source `(read-only)` and the destination as the distinct write target
When destination ≠ source, the rendered plan tags the source as `(read-only)` and shows the destination as the place the branches and PR are created, unambiguously distinct from the source. (Replaces the old `--fork` `Into:`/`(fork — …)` wording.)
Evidence: test(test/plan.test.ts)

### VAL-PLAN-002: destination == source → plan does NOT tag the source `(read-only)`
When destination == source, the plan does not tag the source `(read-only)`; it shows the single repo as the place both the read and the write happen. The pre-existing fork plan test (`test/plan.fork.test.ts`) is migrated into `test/plan.test.ts` or removed, since the `--fork` wording it asserts no longer exists.
Evidence: test(test/plan.test.ts) + grep(no `Into:`/`(fork` wording remaining in src/plan.ts)

### VAL-CLI-001: `--fork` is gone; `--primary`, `--sandbox`, `--create-sandbox` are documented in `--help` and README
`--fork` no longer exists anywhere in `src/`. `--primary`, `--sandbox <owner/repo>`, and `--create-sandbox` are registered commander options (appear in `--help`) and are documented in `README.md`.
Evidence: grep(no `--fork`, and the three flags present, in src/cli.ts and README.md) + test(test/cli.test.ts)

### VAL-CLI-002: `--create-sandbox` without `--sandbox` is a documented no-op
Passing `--create-sandbox` without `--sandbox` does NOT error and does NOT create any repo — it has no effect (the §10 item 6 decision is: no-op, matching the §4.3 flag table "No effect without --sandbox"), and this is documented. Resolution proceeds exactly as if `--create-sandbox` were absent.
Evidence: test(test/destination.test.ts) + grep(no-op documented in README.md)

---

## Area: Invariants

### VAL-INV-001: destination ≠ source → the source is never an argument to a write call
When destination ≠ source, the recorded calls show the source `owner/repo` is never passed to `pushBranchFromSha`, `createPullRequest`, or any repo-creation call; the source appears only in reads (`getPullRequest`, `listPullRequestCommits`, `getCommitParentSha`) and as the `source` fetch remote.
Evidence: test(test/destination.test.ts asserting call args) + grep

### VAL-INV-002: token safety holds through the creation and verification paths
The token is never logged, printed, written anywhere except the 0600 config, put into a remote URL, or placed on a git command line — including the new verify (`repos.get`) and create (`repos.create*`) paths. Concretely: the token reaches Octokit only via `makeOctokit(token)`; the new verify/create wrappers take an `octokit` instance, never a raw token, and never construct a URL or git arg from it.
Evidence: grep(no token/secret interpolated into a URL or git command line, and verify/create wrappers take `octokit` not a token, in src/) + test(extend test/auth.test.ts token-safety coverage to the new paths)

### VAL-INV-003: no new runtime dependency is added
`package.json` `dependencies` is unchanged from the pre-mission set (`@octokit/rest`, `chalk`, `commander`, `prompts`, `simple-git`). Creation/verification reuse the existing Octokit instance; prompting reuses `prompts`.
Evidence: grep(package.json dependencies unchanged) + tsc-clean

### VAL-INV-004: the duplicate-PR check targets the destination, not the source
`findExistingPr` (pre-flight) and the 422-recovery lookup are called with the **destination** `owner/repo`, not the source, whenever destination ≠ source (§10 item 9). Asserted on the recorded call args.
Evidence: test(test/destination.test.ts asserting findExistingPr call args) + grep(findExistingPr called with destOwner/destRepo in src/index.ts)

---

## Area: Quality gates

### VAL-GATE-001: `tsc` is clean
`npm run build` (`tsc`) exits 0 with no type errors across `src/`.
Evidence: tsc-clean

### VAL-GATE-002: lint is clean
The project's static-analysis gate passes. No dedicated linter is configured, so this is satisfied by `tsc --strict` exiting 0 (same command as VAL-GATE-001); the validator notes the absence of a separate linter rather than inventing one.
Evidence: lint-clean

### VAL-GATE-003: README and auth guidance document the destination model, read-only guarantee, new flags, and the two-repo token
`README.md` explains the primary-vs-sandbox destination model, states the read-only guarantee for the source repo, documents `--primary` / `--sandbox` / `--create-sandbox`, and notes (§6.2) that a non-primary destination needs a token covering read on the source AND write on the destination. The interactive token guidance in `src/auth.ts` is updated to state the same two-repo requirement (§6.2). (§10 item 4c's runtime path — a sandbox-only token failing to read a private source — is the existing 404 handling and out of scope; only the guidance is new.)
Evidence: manual(read README) + grep(destination/sandbox/read-only/--primary/--sandbox in README.md AND two-repo / source+destination wording in src/auth.ts)
