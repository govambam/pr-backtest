# Spec: Live activity trace

**Spec ID:** `live-activity-trace`
**Status:** Draft, ready for `/mission`
**Builds on:** `src/log.ts` (stderr logger, `registerSecret`/`redact`), `src/github.ts` (`makeOctokit`), `src/git.ts` (clone/fetch/push), and the call sites in `src/index.ts`.
**Base branch:** current working branch.
**Independent of:** `specs/sandbox-destination.md`. This spec only adds observability around operations that already exist; it does not change what operations run or where they write.

---

## 1. Background

The tool's value proposition is trust: it will not do anything destructive or noisy to a repo the user cares about. Today the run emits a few friendly `step()` lines, but it does not show the user the actual operations as they happen. A live trace — every GitHub API call and every git command, shown in real time — converts the abstract safety guarantee into something the user can watch and verify: that the tool only ever reads the source, only writes the chosen destination, and only ever talks to `api.github.com`.

A key enabler already exists in the codebase: because the token is supplied to git via `GIT_ASKPASS` (never in the remote URL, never on the command line — see `src/git.ts`), the **real** git command line contains no secret and can be shown verbatim. The logger already routes all progress to stderr (keeping stdout reserved for the final PR URL) and scrubs registered secrets from every line. This spec builds the trace on that foundation.

## 2. Goal

Give the user a real-time, accurate, secret-free view of every network call and git command the tool performs, so they can see for themselves that the run is safe. The default view stays clean; a `--verbose` view shows the exhaustive trace for a skeptical reader.

## 3. Non-goals (out of scope)

- **Changing any operation, ordering, write target, or exit code.** Pure observability.
- **A frame-animated spinner** (e.g. an `ora`-style spinner). No new dependency; see §6 for the allowed in-place update.
- **Streaming raw git stderr/stdout** to the user. Explicitly forbidden (§7) — the git child's stderr can echo a credential header. Trace lines are constructed by the tool, not piped from git.
- **A machine-readable trace format** (JSON logs, `--output json`). Human-readable only in v1.
- **Tracing anything written to stdout.** stdout stays exactly the final PR URL.

## 4. User-facing behavior

### 4.1 Default view

The existing friendly step narration, upgraded so each operation shows a start and a completion marker. Example (sandbox run):

```
✓ Authenticated as @octocat
✓ Read PR acme/api#123  "Add retry to fetch"
✓ Verified destination octocat/pr-backtest-sandbox (write access OK)
✓ Cloned octocat/pr-backtest-sandbox
✓ Fetched base 9f3c1a2 and head a1b2c3d from source
✓ Pushed base → backtest-pr123-base
✓ Pushed head → backtest-pr123-head
✓ Opened backtest PR
```

Friendly labels, redacted repo refs, short SHAs, branch names. No raw paths or argv at this level. On a TTY, a slow operation (clone/fetch/push) first shows an in-progress line that is replaced in place by its completion line (§6); when not a TTY, only the completion line prints.

### 4.2 `--verbose` view

Adds, interleaved in real time, one dim line per **GitHub API request** and per **git command**, including the exact method/path or argv and an elapsed time. This is the "show me everything" mode for a skeptical user:

```
  → GET   /repos/acme/api/pulls/123                         200  142ms
  → GET   /repos/acme/api/pulls/123/commits?per_page=100    200  98ms
  → GET   /repos/octocat/pr-backtest-sandbox                200  88ms
  $ git clone --no-checkout https://x-access-token@github.com/octocat/pr-backtest-sandbox.git <tmp>/repo   1.1s
  $ git fetch source 9f3c1a2                                312ms
  $ git fetch source a1b2c3d                                208ms
  $ git push origin 9f3c1a2:refs/heads/backtest-pr123-base  640ms
  $ git push origin a1b2c3d:refs/heads/backtest-pr123-head  590ms
  → POST  /repos/octocat/pr-backtest-sandbox/pulls          201  301ms
```

The flag is `--verbose` (commander option in `src/cli.ts`), default off. (Taste decision left open: whether to make verbose the default given the trust-first audience. v1 ships gated; flipping the default later is a one-line change.)

### 4.3 Channel discipline

- All trace output goes to **stderr** (as today). stdout remains exactly the final PR URL on success, so piping is unaffected.
- Trace lines pass through `redact()` so any registered secret is scrubbed even if an upstream string carries it.

## 5. API tracing (Octokit hook)

Attach a request hook (`octokit.hook.before` / `octokit.hook.after` / `octokit.hook.error`) **once, in a single Octokit factory**, so every request the tool makes is traced automatically — no per-call-site annotation, and no call can be silently omitted.

- Centralize construction: `makeOctokit` in `src/github.ts` becomes the sole factory and installs the hook. `src/auth.ts`'s default Octokit (currently `new Octokit({ auth })` for token validation) must route through this factory so the validation call is traced too and carries the same `userAgent`.
- The hook records, per request: HTTP method, URL **path + query** (never the body, which can contain large diffs and is noise), response status, and elapsed ms.
- **Host assertion (doubles as enforcement of SPEC §5.5):** the hook asserts every request host is `api.github.com` (the configured GitHub API base). Any other host is a hard error — this both prevents a mis-trace and enforces the "only api.github.com" invariant at runtime.
- In default mode the hook updates timing/▢ state but does not print a per-request line; in `--verbose` it prints the dim request line in real time.
- The token never appears in a traced line: only method/path/status/timing are recorded, and `redact()` is the final net.

## 6. Git tracing (constructed argv)

For each git operation in `src/git.ts` (`clone`, `addRemote`, `fetch`, `push`), the tool constructs a **display string mirroring the real command** and traces it. Because the token is supplied via `GIT_ASKPASS` and never appears in the URL or argv, the displayed command equals the real one and is secret-free.

- Construct the string from the same inputs passed to `simple-git` (URL from `repoHttpsUrl`, the SHA, the refspec). Do **not** attempt to capture `simple-git`'s internal argv or its child stderr.
- In-progress / completion behavior:
  - **TTY:** print a transient in-progress line for the operation, then overwrite that single line in place (carriage return) with the completion line carrying elapsed time. One line rewrite — no animation frames, no spinner library.
  - **Not a TTY:** print only the completion line. No carriage returns, no overwrites.
- `--verbose` additionally prints the constructed `$ git …` argv line with timing.
- Errors: on a git failure the trace shows the operation failed (constructed line + "failed"); the existing token-free domain errors (`UnfetchableCommitError`, the generic push/clone errors) are still what reach the user. Raw git stderr is never shown (§7).

## 7. Safety and invariants (hard requirements)

- **INV-NO-RAW-GIT-STDERR:** the git child's stderr/stdout is never streamed or printed to the user. All git trace lines are tool-constructed. (Rationale: the code already notes git stderr "can echo the credential header.")
- **INV-NO-TOKEN-IN-TRACE:** no traced line — API or git, default or verbose — ever contains the token or a derived credential. The token appears in argv/URL by construction nowhere; `registerSecret` + `redact()` remain the final scrub on every line.
- **INV-STDOUT-CLEAN:** stdout on success is exactly the PR URL plus newline, unchanged by this feature. All trace goes to stderr.
- **INV-HOST:** every API request host is `api.github.com`; any other host is a hard error.
- **INV-NO-DEP:** no new runtime dependency. Color via the existing `chalk`; in-place line update via carriage return; timing via the tool's own clock.
- **INV-NO-BEHAVIOR-CHANGE:** the set, order, targets, and exit codes of operations are identical to before this feature. Tracing is observation only.

## 8. Existing code to reuse (do not rebuild)

- `src/log.ts` already provides stderr routing, `chalk` styling, and `registerSecret`/`redact`. Add the trace renderer here (a small `trace`/`traceStep` surface) rather than a new logging stack.
- `makeOctokit` (`src/github.ts`) is the single place to install the API hook.
- `redactedRepoRef`, `shortSha`, `repoHttpsUrl` (`src/git.ts`, `src/util.ts`) already produce the redacted/short forms the trace lines need.
- The friendly `step()` call sites in `src/index.ts` are the basis for the §4.1 default lines; upgrade them to emit completion markers rather than adding a parallel set of logs.

## 9. Acceptance criteria

Each line is a pass/fail assertion with a suggested mission-contract Evidence tag.

### API tracing
- **AC-API-001** Every GitHub API request the tool makes is traced via a hook installed in the single `makeOctokit` factory; no API call site adds its own trace line. — `test(test/trace.test.ts with a fake transport asserting hook fires per request)` + `grep(hook installed once in src/github.ts)`
- **AC-API-002** `auth.ts` token validation routes through the shared factory, so the `GET /user` validation call is traced. — `test(test/auth.test.ts)`
- **AC-API-003** In `--verbose`, each API request prints a real-time line with method, path+query, status, and elapsed ms; in default mode no per-request line prints. — `test(test/trace.test.ts)`
- **AC-API-004** A request to any host other than `api.github.com` is a hard error. — `test(test/trace.test.ts)`

### Git tracing
- **AC-GIT-001** Each git operation traces a constructed command string built from the tool's own inputs, never from `simple-git`'s internals or the git child's output. — `test(test/git.test.ts)` + `grep(no outputHandler / no child stderr capture in src/git.ts)`
- **AC-GIT-002** In `--verbose`, each git op prints a `$ git …` line with elapsed time; the displayed clone URL is `https://x-access-token@github.com/<owner>/<repo>.git` with no token. — `test(test/git.test.ts)` + `grep`
- **AC-GIT-003** On a TTY, a git op shows an in-progress line replaced in place by a completion line; with no TTY only the completion line prints (no carriage returns). — `test(test/trace.test.ts with TTY true/false)`

### Verbosity and channel
- **AC-CH-001** All trace output is on stderr; on success stdout is exactly the PR URL + newline. — `test(test/index.test.ts capturing stdout vs stderr)`
- **AC-CH-002** `--verbose` is a documented commander flag, default off; `--help` lists it. — `test(test/cli.test.ts)` + `grep(README.md)`

### Safety
- **AC-SAFE-001** No traced line (API or git, default or verbose) contains the token; a test that registers a sentinel token and runs a full traced flow asserts the sentinel never appears in captured stderr. — `test(test/trace.test.ts)`
- **AC-SAFE-002** Raw git stderr/stdout is never written to the user on success or failure. — `test(test/git.test.ts)` + `grep`
- **AC-SAFE-003** The operations, their order, write targets, and exit codes are unchanged by this feature (a before/after of the orchestration is identical). — `test(test/index.test.ts)`

### Quality gates
- **AC-GATE-001** `tsc` clean. — `tsc-clean`
- **AC-GATE-002** Lint clean. — `lint-clean`
- **AC-GATE-003** No new entry under `dependencies` in `package.json`. — `grep`
- **AC-GATE-004** README documents the live trace and `--verbose`, including the point that the displayed git commands are the real ones and carry no token. — `manual(read README)` + `grep`

## 10. Suggested decomposition (for the mission orchestrator)

One milestone, top-down:

1. **trace-core** — the renderer in `log.ts`: start/complete markers, TTY-aware in-place update, `--verbose` gating, timing, all on stderr through `redact()`. (AC-CH-*, AC-GIT-003, AC-SAFE-001 net)
2. **api-hook** — centralize `makeOctokit`, install the request hook, route `auth.ts` through it, host assertion. (AC-API-*, INV-HOST)
3. **git-trace** — constructed-argv tracing in `git.ts`'s clone/addRemote/fetch/push; no child-output capture. (AC-GIT-001/002, AC-SAFE-002)
4. **wire-and-docs** — upgrade `index.ts` step sites to completion markers, add the `--verbose` flag in `cli.ts`, README. (AC-CH-002, AC-GATE-004, AC-SAFE-003)

`trace-core` and `api-hook` are foundational and may carry `"fulfills": []` for assertions only completed by a later user-facing feature; the orchestrator assigns each assertion to exactly one feature per the coverage invariant.
