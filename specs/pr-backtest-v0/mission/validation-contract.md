# Validation contract — pr-backtest-v0

Spec source: **`SPEC.md`** at repo root (this project keeps its spec at the root, not under `specs/`).

Every assertion has a stable ID and an `Evidence:` line. The validator runs the evidence to score pass/fail. Manual checks are flagged explicitly — the validator marks those `"blocked"` and surfaces them for human verification.

This is a **greenfield** build: there is no prior `src/`, `package.json`, or test runner. The cumulative diff (`git diff main...HEAD`) is the entire tool. `tsc-clean` therefore means the whole project typechecks/builds once wired.

> **Patched after adversarial review.** Greps were tightened from single common words to specific call-sites / literals, runtime-only behaviors are verified by the prescribed unit tests or flagged `manual`, the exit-code mapping is owned solely by `VAL-CLI-003` (other assertions describe detection/behavior, not the numeric code), and the spec's negative design decisions (no comment-back, no cross-ref rewrite) and onboarding/config-path behaviors are now covered.

## Evidence vocabulary

- `tsc-clean` — `npm run build` (or `npx tsc --noEmit`) exits 0 across the whole project
- `test(<path>)` — the named test file passes under the project's test runner
- `grep(<pattern> in <path>)` — pattern matches; when the line says **must NOT match**, the validator confirms the pattern is absent
- `manual(<step>)` — human verification required (live end-to-end run, security read-through, global install)

---

## Area: URL parsing (`src/parseUrl.ts`)

### VAL-URL-001: Valid PR URL parses to {owner, repo, number}
`parseUrl("https://github.com/acme/api/pull/123")` returns `{ owner: "acme", repo: "api", number: 123 }` (number is an integer, not a string).
Evidence: test(test/parseUrl.test.ts)

### VAL-URL-002: Trailing slashes and query strings are tolerated
URLs with a trailing `/`, a trailing path segment (e.g. `/files`), or a `?query=...` suffix still parse to the same `{owner, repo, number}`.
Evidence: test(test/parseUrl.test.ts)

### VAL-URL-003: Invalid or non-PR URLs are rejected with a clear error
A non-GitHub URL, a repo URL with no `/pull/<n>`, or a malformed string causes `parseUrl` to throw an `Error` with a human-readable message — it does not return a partial/garbage object.
Evidence: test(test/parseUrl.test.ts)

---

## Area: Commit resolution (`src/resolveCommit.ts`)

### VAL-CMT-001: `initial` resolves to the first non-merge commit of the PR
Given the PR's commit list (in `pulls.listCommits` order), `initial` selects the earliest-listed commit with exactly one parent (skips merge commits) and returns its SHA as the target.
Evidence: test(test/resolveCommit.test.ts)

### VAL-CMT-002: An explicit SHA (full or abbreviated) is used directly and validated
`--commit <sha>` — full or a ≥7-char abbreviation — is matched against the PR's commits and used as the target; a SHA that matches no PR commit is rejected with a clear error.
Evidence: test(test/resolveCommit.test.ts)

### VAL-CMT-003: Base commit is the parent of the target
The resolved base SHA equals the target commit's first parent (`parents[0]`). Resolution lives in `src/resolveCommit.ts`; the GitHub `getCommit` lookup is injected/mocked in the test.
Evidence: test(test/resolveCommit.test.ts)

### VAL-CMT-004: Invalid `--commit` input fails with a clear error
A value that is neither `initial` nor a syntactically valid (hex, ≥7-char) commit SHA is rejected with a human-readable error before any network/git work.
Evidence: test(test/resolveCommit.test.ts)

---

## Area: Authentication & config (`src/auth.ts`, `src/config.ts`)

### VAL-AUTH-001: Token resolution order is env → config → gh CLI → interactive
Resolution tries, first match wins: (1) `GITHUB_TOKEN` env var, (2) the config file, (3) `gh auth token` (only after the user accepts the reuse prompt), (4) interactive paste. The test asserts env beats config beats gh.
Evidence: test(test/auth.test.ts)

### VAL-AUTH-002: Token is validated via `users.getAuthenticated`, surfacing the username
After a token is obtained, the tool calls `octokit.users.getAuthenticated()` to validate it and prints the authenticated username (e.g. `Authenticated as @user`); an invalid token fails fast.
Evidence: grep(getAuthenticated in src/auth.ts)

### VAL-AUTH-003: Config file is written with mode 0600
When the tool persists the token it writes the config file with octal mode `0600` (owner read/write only), via a `mode: 0o600` / `chmod 0o600` call.
Evidence: grep(0o600 in src/config.ts)

### VAL-AUTH-004: Loosened config permissions trigger a warning on read
On read, the tool masks the file mode against group/other bits (`0o077`) and warns if any are set.
Evidence: grep(0o077 in src/config.ts)

### VAL-AUTH-005: No token + non-TTY exits 1 with setup guidance
If no token is resolvable and `stdin` is not a TTY, the tool exits `1` with a message pointing at setup instructions — it does not block waiting for input. The non-TTY branch keys off `stdin.isTTY`.
Evidence: grep(isTTY in src/auth.ts)

### VAL-AUTH-006: `logout` deletes the saved config, tolerating absence
`pr-backtest logout` removes the config file via `fs`'s `unlink`/`rm`, and does not error when the file is already absent.
Evidence: grep(unlink in src/config.ts)

### VAL-AUTH-007: Interactive token entry is masked
The interactive token prompt does not echo the token (uses a `prompts` `type: 'password'` or `'invisible'` input).
Evidence: grep(password|invisible in src/auth.ts)

### VAL-AUTH-008: Config schema records token, username, and a constrained source
The persisted config includes `token`, `username`, and a `source` field constrained to `fine-grained` | `classic` | `gh-cli` (the literal `fine-grained` appears).
Evidence: grep(fine-grained in src/config.ts)

### VAL-AUTH-009: Config path is XDG-aware (and `%APPDATA%` on Windows)
The config path honors `XDG_CONFIG_HOME` (default `~/.config/pr-backtest/config.json`) and uses `%APPDATA%\pr-backtest` on Windows.
Evidence: grep(XDG_CONFIG_HOME in src/config.ts)

### VAL-AUTH-010: gh CLI token is offered for reuse, with a prompt before use
When `gh` is installed and authenticated, the tool offers to reuse its token (runs `gh auth token`) only after the user confirms; declining falls through to the next resolution step.
Evidence: grep(gh auth token in src/auth.ts)

### VAL-AUTH-011: Fine-grained PAT guidance is shown when gh is unavailable
When `gh` is not available, the tool prints the fine-grained-PAT walkthrough — the Contents / Pull requests / Metadata permissions and the `settings/personal-access-tokens` URL.
Evidence: grep(personal-access-tokens in src/auth.ts)

---

## Area: GitHub API (`src/github.ts`)

### VAL-GH-001: PR and its commits are fetched via the REST API
The tool fetches the PR (`pulls.get`) and its commit list (`pulls.listCommits`) through Octokit.
Evidence: grep(listCommits in src/github.ts)

### VAL-GH-002: Existing-PR pre-flight check returns the existing PR's URL
Before creating anything, the tool lists PRs for the planned head/base pair (`pulls.list`); if one exists it returns/prints that PR's `html_url` so the caller can surface it.
Evidence: grep(pulls.list in src/github.ts)

### VAL-GH-003: The simulated PR is created head → base
The tool opens the new PR from the head branch to the base branch via `octokit ... pulls.create`.
Evidence: grep(pulls.create in src/github.ts)

### VAL-GH-004: No comment is posted back to the original PR
Per SPEC §5 (no `@macroscope review` auto-comment), the tool posts no comment/issue to any PR.
Evidence: grep(createComment in src/github.ts) — must NOT match (nor `issues.create`)

---

## Area: Git operations (`src/git.ts`)

### VAL-GIT-001: Repo is cloned into a `pr-backtest-` temp directory
The tool clones the upstream repo over HTTPS into a temp directory whose name contains `pr-backtest-`.
Evidence: grep(pr-backtest- in src/git.ts)

### VAL-GIT-002: Target and base commits are fetched from origin
The tool fetches the specific target and base commit SHAs from `origin` via a `.fetch(` / `.raw(['fetch'` call (not a full-branch checkout).
Evidence: grep(.fetch( in src/git.ts)

### VAL-GIT-003: Commits are pushed as `backtest-pr<N>` branches by SHA
The tool pushes the two SHAs to new branches using the `<sha>:refs/heads/backtest-pr<N>-base` / `...-head` refspec form (no local checkout of the commits).
Evidence: grep(refs/heads/backtest-pr in src/git.ts)

### VAL-GIT-004: `main` is never checked out
`src/git.ts` calls no `simple-git` checkout method (`.checkout`, `.checkoutBranch`, `.checkoutLocalBranch`) — the SHA-to-refspec push path needs none. (`--no-checkout` clone options are allowed; they do not match `.checkout`.)
Evidence: grep(.checkout in src/git.ts) — must NOT match

### VAL-GIT-005: Unfetchable commit produces the actionable §6.5 error (both fallback lines)
When a fetch of the target or its parent fails, the tool surfaces the SPEC §6.5 error — the `Could not fetch commit` text plus the manual `git push origin <sha>:refs/heads/backtest-pr<N>-head` **and** `<sha>^:refs/heads/backtest-pr<N>-base` fallback lines — not raw git stderr.
Evidence: grep(Could not fetch commit in src/git.ts)

### VAL-GIT-006: Temp dir is always cleaned up
Cleanup of the temp clone runs on success and failure, wired through a `finally` block and a `process.on('exit', ...)` handler.
Evidence: grep(process.on in src/git.ts)

### VAL-GIT-007: No commit rewriting / cross-reference stripping
Per SPEC §5, the tool does not amend or rebase commits to rewrite `#123` references; there is no `commit --amend` / `git.raw(['rebase'` machinery.
Evidence: grep(amend in src/git.ts) — must NOT match (nor `rebase`)

---

## Area: Plan & confirm (`src/plan.ts`)

### VAL-PLAN-001: Plan prints PR, target, base, and numbered steps
Before any state change, the rendered plan shows the PR identity, the target commit (short SHA + label), the base commit, and the numbered clone/fetch/push/open steps.
Evidence: grep(Plan: in src/plan.ts)

### VAL-PLAN-002: Confirmation prompt; declining means no state change
The tool prompts `[y/N]` (the literal `Continue` prompt); a "no"/empty answer returns a "declined" outcome so the caller performs no clone/push/PR-create. (The decline→exit-0 mapping is owned by VAL-CLI-003.)
Evidence: grep(Continue in src/plan.ts)

### VAL-PLAN-003: `-y`/`--yes` skips the confirmation prompt
`plan.ts` accepts a skip/`yes` flag that, when set, prints the plan but does not invoke the interactive prompt.
Evidence: grep(yes in src/plan.ts)

---

## Area: CLI surface, exit codes & output (`src/cli.ts`, `src/index.ts`, `src/log.ts`)

### VAL-CLI-001: Commander exposes the command, flags, and `logout`
The CLI defines the main `<pr-url>` command with `--commit <ref>` and `-y, --yes` options, plus a `logout` subcommand.
Evidence: grep(logout in src/cli.ts)

### VAL-CLI-002: An unparseable URL maps to exit 1
`src/index.ts` calls `parseUrl` and turns a parse failure into the bad-args exit path (code 1), rather than crashing with a stack trace.
Evidence: grep(parseUrl in src/index.ts)

### VAL-CLI-003: Exit codes follow the spec mapping (sole owner of the numeric codes)
`src/index.ts` maps outcomes to SPEC §3 codes — `0` success/decline, `1` bad args, `2` PR-not-found/API error, `3` git failure, `4` existing PR — and the distinct literals `1`/`2`/`3`/`4` appear at `process.exit(...)` / a code map.
Evidence: grep(process.exit in src/index.ts)

### VAL-CLI-004: PR URL is written to stdout; progress goes to stderr
On success the created PR URL is written to **stdout** as the final line (pipe-friendly); `src/log.ts` writes all plan/progress to **stderr**.
Evidence: grep(stdout in src/index.ts)

### VAL-CLI-005: `--commit` defaults to `initial`
When `--commit` is omitted, the resolved ref is `initial` (the commander option default is the string `initial`).
Evidence: grep(initial in src/cli.ts)

---

## Area: Packaging, dependencies & docs

### VAL-PKG-001: Runtime dependencies are exactly the five allowed
`package.json` `dependencies` contains only `commander`, `@octokit/rest`, `simple-git`, `prompts`, `chalk` — no telemetry/analytics/error-reporting packages. The validator parses the JSON and confirms the dependency key set equals exactly those five.
Evidence: grep(@octokit/rest in package.json)

### VAL-PKG-002: No direct network calls outside Octokit / simple-git
`src/` makes no direct `fetch`/`https.request`/`node-fetch`/`axios`/`got` call; all network egress is through the Octokit instance or `simple-git` (both resolved from `node_modules`, not `src/`).
Evidence: grep(node-fetch|axios|https.request|fetch( in src/) — must NOT match

### VAL-PKG-003: `bin/pr-backtest` wraps `dist/cli.js`
A `bin/pr-backtest` shebang wrapper invokes `dist/cli.js`, and `package.json` `bin` maps `pr-backtest` to it.
Evidence: grep(dist/cli.js in bin/pr-backtest)

### VAL-PKG-004: TypeScript strict mode is on
`tsconfig.json` enables `"strict": true`.
Evidence: grep(strict in tsconfig.json)

### VAL-PKG-005: MIT license file present
A top-level `LICENSE` file contains the MIT license body.
Evidence: grep(Permission is hereby granted in LICENSE)

### VAL-PKG-006: README covers all required §9 sections
`README.md` contains the SPEC §9 sections: What this does, The problem it solves, Install, Setup, Usage, How it works, Safety, Privacy & security, Limitations, Contributing, License — and the Privacy section states no telemetry and only `api.github.com` + `github.com` egress. Validator confirms each heading is present.
Evidence: grep(Privacy in README.md)

### VAL-PKG-007: The whole project typechecks/builds cleanly
With every module wired, `npm run build` (tsc) exits 0 and emits `dist/`.
Evidence: tsc-clean

### VAL-PKG-008: No `any` / no unexplained `@ts-ignore`
`src/` contains no bare `@ts-ignore` (without an inline reason) and no `: any`.
Evidence: grep(@ts-ignore in src/) — must NOT match; and grep(: any in src/) — must NOT match

### VAL-PKG-010: Global install yields a working binary
`npm install -g .` from the repo produces a `pr-backtest` command whose `--help` runs (SPEC §11 DoD). Validator cannot perform a global install.
Evidence: manual(npm install -g . then `pr-backtest --help`)

---

## Area: Tests

### VAL-TEST-001: parseUrl unit tests exist and pass
`test/parseUrl.test.ts` exists and passes, covering valid URLs, trailing slashes/query strings, and invalid URLs.
Evidence: test(test/parseUrl.test.ts)

### VAL-TEST-002: resolveCommit unit tests exist and pass
`test/resolveCommit.test.ts` exists and passes, covering `initial`, explicit SHA, and invalid input.
Evidence: test(test/resolveCommit.test.ts)

### VAL-TEST-003: Integration test against a public fixture PR, gated on GITHUB_TOKEN
`test/integration.test.ts` exists, is skipped when `GITHUB_TOKEN` is unset, honors a `TEST_FIXTURE_REPO` override, and (when a token is set) runs end-to-end against a public fixture PR asserting diff/branch-names/cleanup. The validator cannot supply a token.
Evidence: manual(run test/integration.test.ts with GITHUB_TOKEN set)

---

## Cross-Area Flows

### VAL-CROSS-001: End-to-end backtest creates a matching PR and cleans up
Running `pr-backtest <real-pr-url>` against a repo the user can push to: prints the plan, pushes `backtest-pr<N>-base` and `backtest-pr<N>-head`, opens a PR whose diff equals the target commit's diff (head at the chosen commit, base at its parent), prints the URL on stdout, and leaves no `/tmp/pr-backtest-*` dir behind. A second run prints the existing PR URL and exits `4`.
Evidence: manual(end-to-end smoke test per SPEC §8)

### VAL-CROSS-002: Token is never logged, printed, or written to the temp dir
Across `src/log.ts`, `src/index.ts`, `src/git.ts`, and `src/auth.ts`, the token value is never passed to a log/console call, never printed to stdout/stderr, and never written into the temp clone directory.
Evidence: manual(security read-through of log/index/git/auth modules)
