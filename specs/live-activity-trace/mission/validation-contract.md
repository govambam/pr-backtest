# Validation contract — live-activity-trace

Every assertion has a stable ID and an `Evidence:` line. The validator runs the evidence to score pass/fail. Manual checks are flagged explicitly — the validator marks those `"blocked"` and surfaces them for human verification.

Source of truth: `specs/live-activity-trace.md` §9 (acceptance criteria) and §7 (hard invariants). This contract translates those into testable assertions, de-overlapped so each behavior is claimed exactly once. (Patched after a three-agent adversarial review pass — see `adversarial-review-notes.md`.)

## Evidence vocabulary

- `tsc-clean` — `npm run build` (i.e. `tsc`) exits 0 with no errors.
- `lint-clean` — the project's lint command exits 0. **Note:** this repo has no linter configured (no `lint` script, no eslint/prettier config); `tsc --strict` is the de-facto gate. The validator runs a lint script if one exists, otherwise marks the assertion `blocked` with "no linter configured".
- `test(<path>)` — the named test file passes under `node --import tsx --test`.
- `grep(<pattern> in <path>)` — pattern matches (or must NOT match, per the assertion wording).
- `manual(<step>)` — human verification required (reading README prose, etc.); validator marks `blocked`.

Test-runner reference: `npm test` runs `node --import tsx --test test/*.test.ts`. New test files (`test/trace.test.ts`, `test/index.test.ts`) follow the existing `node:test` + `node:assert/strict` convention in `test/git.test.ts`. The §8/§10 design intent is that the trace **renderer** lives in `src/log.ts`; `makeOctokit` (`src/github.ts`) installs the API hook; `src/git.ts` constructs git display strings; `src/index.ts` step sites and `src/cli.ts` are wired last.

---

## Area: API tracing

### VAL-API-001: Single-factory hook, installed once, no per-call-site tracing
The Octokit request hook is installed exactly once, inside the single `makeOctokit` factory in `src/github.ts`. Every request made through a factory-built Octokit passes through the hook (proven by a fake-transport counter: N requests → hook fires N times). No API call site in `src/index.ts` or `src/auth.ts` installs its own hook or adds a per-request trace line. (This assertion owns *installation locus and automatic coverage*; the printed content/gating is VAL-API-003.)
Evidence: `test(test/trace.test.ts)` (fake transport: hook fires once per request, zero per-call-site setup) + `grep(octokit.hook wiring appears only in src/github.ts; none in src/index.ts or src/auth.ts)`

### VAL-API-002: auth.ts validation routes through the shared factory
On the default (non-injected) path, `auth.ts` builds its token-validation Octokit via the shared `makeOctokit` factory from `./github.js` — so the `GET /user` validation call is traced and carries the `pr-backtest` userAgent. The existing `options.makeOctokit` test-injection seam is preserved (its fallback may still reference `new Octokit`; that is the injection seam, not the production path).
Evidence: `grep(src/auth.ts imports makeOctokit from "./github.js" and uses it as the default validation-Octokit factory)` + `test(test/auth.test.ts)` (injection seam still works; default factory is the shared one)

### VAL-API-003: Verbose prints per-request line content; default prints none
With verbose enabled, each API request prints exactly one stderr line containing: the HTTP method, the URL path **plus query string** (never the request body), the response status, and an elapsed figure formatted as `<N>ms` (e.g. `142ms`). With verbose disabled, the hook still records timing/state but prints **no** per-request line.
Evidence: `test(test/trace.test.ts)` (verbose run: each request yields a line matching method + path(+query) + status + `/\d+ms/`, and the body never appears; default run: zero per-request lines)

### VAL-API-004: Non-base host is a hard error
The hook compares each request's host against the configured GitHub API base host (`api.github.com`). A request whose host is anything else (the test fabricates one to e.g. `evil.example.com`) makes the hook **throw** — a hard error, not a silent skip. (The tool issues no uploads/codeload requests, so `api.github.com` is the only legitimate host; this is runtime enforcement of SPEC §5.5 / INV-HOST.)
Evidence: `test(test/trace.test.ts)` (a fabricated request to a non-`api.github.com` host throws)

---

## Area: Git tracing

### VAL-GIT-001: Constructed argv, never from simple-git internals or child output
Each git operation in `src/git.ts` (`clone`, `addRemote`, `fetch`, `push`) traces a display command string built from the tool's own inputs (the `repoHttpsUrl`, the SHA, the refspec, the remote name) — never captured from `simple-git`'s internal argv and never from the git child's stdout/stderr.
Evidence: `test(test/git.test.ts)` (the constructed display string for each op is the expected argv given known inputs) + `grep(src/git.ts has no \`outputHandler\`, no \`progress\` handler, and no capture of the git child's \`.stdout\`/\`.stderr\` streams)`

### VAL-GIT-002: Verbose `$ git …` line is the real, token-free command
With verbose enabled, each git op prints a `$ git …` line carrying the constructed argv and an elapsed time. The displayed clone URL is exactly `https://x-access-token@github.com/<owner>/<repo>.git` — the `x-access-token` username only, with no `:password@` / token component.
Evidence: `test(test/git.test.ts)` (the verbose clone line shows the `x-access-token@…` URL) + `grep(repoHttpsUrl in src/git.ts yields x-access-token@ with no \`:<secret>@\` form)`

### VAL-GIT-003: TTY in-place update; non-TTY single line
On a TTY, a git op prints a transient in-progress line that is then overwritten **in place** via a carriage return (single-line rewrite) by the completion line carrying elapsed time. When the stream is not a TTY, only the completion line prints, with no carriage returns. (The renderer that does this lives in `src/log.ts`; "no spinner library / no new dependency" is enforced by VAL-GATE-003, not here.)
Evidence: `test(test/trace.test.ts)` (drive the `log.ts` renderer with `isTTY` true → output contains a `\r` single-line rewrite; with `isTTY` false → output contains no `\r`)

---

## Area: Verbosity and channel

### VAL-CH-001: Trace on stderr; stdout is exactly the PR URL
All trace output (default and verbose) is written to stderr. On a successful run, stdout is exactly the created PR URL followed by a single newline. (This assertion owns *channel discipline only*; per-request print gating is VAL-API-003, default-view content is VAL-CH-003.)
Evidence: `test(test/index.test.ts)` (full simulated run capturing stdout and stderr separately: `stdout === url + "\n"`; every emitted trace line is on stderr)

### VAL-CH-002: `--verbose` is a real commander flag, default off, in `--help`, no `-v` collision
`--verbose` is registered as a commander option in `src/cli.ts`, defaults to off, and appears in `pr-backtest --help`. It does **not** reassign `-v` (already bound to `--version`) — `--verbose` has no short alias, or a non-conflicting one. README documentation of it is covered separately by VAL-GATE-004.
Evidence: `test(test/cli.test.ts)` (`--help` text includes `--verbose`; omitting it yields verbose=off; `-v`/`--version` still prints the version)

### VAL-CH-003: Default view shows start + completion markers, via upgraded step sites
A default (non-verbose) run emits, for each user-facing operation, the friendly §4.1 narration upgraded with a completion marker (e.g. `✓ Cloned …`). These come from upgrading the existing `src/index.ts` `step()` call sites (and `src/git.ts`'s own `log.step` calls) to emit completion markers — not a parallel logging stack.
Evidence: `test(test/index.test.ts)` (a success run's captured stderr shows `✓` completion markers for the operations: authenticated, read PR, verified/used destination, cloned, fetched, pushed base, pushed head, opened PR)

---

## Area: Safety

### VAL-SAFE-001: Token never appears in any traced line; `redact()` is the proven net
No traced line — API or git, default or verbose — contains the token. A test registers a sentinel secret via `registerSecret`, then (a) drives a full traced flow (API hook lines + git op lines, verbose) and asserts the sentinel never appears in captured stderr, **and** (b) passes a string that *does* contain the sentinel through a trace line and asserts it is scrubbed to `***` — proving `redact()` is the final net, not merely that the token is absent by construction.
Evidence: `test(test/trace.test.ts)`

### VAL-SAFE-002: Raw git child stderr/stdout never reaches the user, incl. the failure path
Raw git stderr/stdout is never streamed or printed to the user on success or failure; every git trace line is tool-constructed. A forced git failure whose child stderr carries a recognizable sentinel must surface only the constructed "failed" trace line and the existing token-free domain error — the sentinel bytes never appear in any user-facing output.
Evidence: `test(test/git.test.ts)` (forced failure with a sentinel on the fake git's stderr → sentinel absent from all captured output) + `grep(src/git.ts does not stream/echo child stdout/stderr and has no \`outputHandler\`)`

### VAL-SAFE-003: Operations, order, targets, and exit codes unchanged
The set of operations, their order, their write targets, and the process exit codes are identical to before this feature — tracing is observation only. The expected success sequence (read PR → verify destination → clone destination → fetch base → fetch head → push base → push head → open PR) and the exit-code mapping are transcribed from the base-commit `runBacktest`.
Evidence: `test(test/index.test.ts)` (asserts the recorded call order for a success path **and** the exit code for at least one failure path — e.g. an unfetchable commit maps to exit 3 — matching base behavior)

---

## Area: Quality gates

### VAL-GATE-001: Typecheck clean
The project typechecks with no errors under strict mode.
Evidence: `tsc-clean`

### VAL-GATE-002: Lint clean
The project's lint command passes. (No linter is configured in this repo; if none exists the validator marks this `blocked` with "no linter configured — tsc strict is the de-facto gate".)
Evidence: `lint-clean`

### VAL-GATE-003: No new runtime dependency (incl. no spinner library)
No new entry is added under `dependencies` in `package.json`: still exactly `@octokit/rest`, `chalk`, `commander`, `prompts`, `simple-git`. In particular no spinner/animation library (`ora` or similar) — color via existing `chalk`, in-place update via carriage return, timing via the tool's own clock (INV-NO-DEP).
Evidence: `grep(dependencies block in package.json unchanged from base — no added package, no ora/spinner dep)`

### VAL-GATE-004: README documents the trace and `--verbose`
The README documents the live activity trace and the `--verbose` flag, including the point that the displayed git commands are the real ones and carry no token.
Evidence: `manual(read README)` + `grep(README.md mentions \`--verbose\` and the trace, and states the shown git commands carry no token)`

---

## Cross-Area Flows

No additional cross-area assertion. VAL-SAFE-001 and VAL-SAFE-003 already exercise the full traced flow end-to-end across the API-hook and git-trace areas; the per-area assertions cover the remaining behavior.
