# Spec: Sandbox destination for simulated PRs

**Spec ID:** `sandbox-destination`
**Status:** Draft, ready for `/mission`
**Builds on:** `SPEC.md` (the v0 tool) and the existing `--fork` write-elsewhere plumbing in `src/index.ts`, `src/git.ts`.
**Base branch:** current working branch.

---

## 1. Background

The v0 tool lands the simulated PR in the PR's own repository by default, and offers `--fork <owner/repo>` to land it elsewhere. Two problems:

1. **The default writes to the user's primary repo.** A first-time user has no way to know, before running, that the tool will push branches and open a PR in the repo their PR came from. That uncertainty is friction: it raises the fear of a destructive or noisy change to a repo they care about.
2. **The `--fork` name is the wrong mental model.** The mechanic is "land the PR in a different repo I control." It is not a GitHub fork, it requires no fork relationship, and (per the design discussion) forking is actively the wrong approach: GitHub frequently disables forking of private repos to personal accounts, programmatic forking is an abuse signal, and you cannot fork a repo into an account that already owns it.

This spec replaces the `--fork` concept with an explicit **destination** model built around a reusable **sandbox repo**, and makes the destination an explicit, up-front choice.

## 2. Goal and guiding principle

**The repository a PR is read from is never written to unless the user explicitly chooses it as the destination.** Reading a PR and its commits is non-destructive; that is always allowed. Writing (pushing branches, opening a PR, creating a repo) only ever happens in the destination the user selected.

The user must be able to land simulated PRs in a repo that is **not** their primary repo, without pre-creating it by hand, and without any forking.

## 3. Non-goals (out of scope)

- **Forking.** No fork creation, no fork detection, no `--fork` flag. Remove `--fork` entirely (the tool is pre-release; no deprecation alias needed).
- **Installing or configuring a review bot** (Macroscope etc.) on the sandbox. The user does that themselves.
- **Multi-destination management** (more than one saved sandbox). Exactly one saved default destination.
- **Mirroring source repo settings** (branch protections, labels, collaborators) into the sandbox.
- **Deleting or cleaning up** sandbox repos or backtest branches.
- **Changing how commits are resolved** (`resolveCommit`), how the token is resolved (`auth`), or the exit-code contract beyond the additions in §9.

## 4. User-facing behavior

### 4.1 Interactive flow (stdin is a TTY, no destination flag given)

1. User runs `pr-backtest <pr-url>`.
2. The tool parses the URL and resolves a token as today.
3. **Before** reading the PR is fine; **before any write** the tool presents a single destination choice via `prompts`:

   **When a saved default destination exists in config:**
   ```
   Where should the simulated PR be created?
     › Primary repo — <source-owner>/<source-repo>
       Sandbox — <saved-owner>/<saved-repo>   (saved default)
       A different repo…
   ```

   **When no saved default destination exists:**
   ```
   Where should the simulated PR be created?
     › Primary repo — <source-owner>/<source-repo>
       Create a sandbox repo
       A different repo…
   ```

4. Resolution of each choice:
   - **Primary repo** → destination = source owner/repo (the v0 same-repo behavior).
   - **Sandbox (saved)** → destination = the saved owner/repo. The tool verifies it still exists and is writable (§6); if not, it explains and re-presents the menu with `Create a sandbox repo` and `A different repo…`.
   - **Create a sandbox repo** → run the creation sub-flow (§5), then use the created repo as the destination.
   - **A different repo…** → prompt for an `owner/repo` slug, verify it exists and is writable (§6), then use it. Offer to save it as the default destination.

5. After resolving a non-primary destination that is not already the saved default, ask once: `Remember <owner>/<repo> as your default sandbox? (Y/n)`. If yes, persist it (§7).

6. Proceed to the existing plan confirmation (§8), then clone/fetch/push/open as today.

### 4.2 Non-interactive flow (flags or no TTY)

Destination is resolved without prompting, in this precedence (first match wins):

1. `--primary` → destination = source repo.
2. `--sandbox <owner/repo>` → destination = that repo.
   - If it does not exist: error unless `--create-sandbox` is also given, in which case create it (§5) non-interactively (private, owner defaults to the source owner, see §5).
3. No destination flag, **not a TTY**: use the saved default destination from config if present; otherwise this is a hard error (exit 1) with guidance to pass `--primary` or `--sandbox`, mirroring `NoTokenNonInteractiveError`.
4. No destination flag, **TTY**: run the interactive flow (§4.1).

`--primary` and `--sandbox` are mutually exclusive (passing both is a bad-args error, exit 1).

### 4.3 Flag surface (commander, `src/cli.ts`)

| Flag | Meaning |
|---|---|
| `--primary` | Land the simulated PR in the PR's own repo (no prompt). |
| `--sandbox <owner/repo>` | Land the simulated PR in this repo (no prompt). Replaces `--fork`. |
| `--create-sandbox` | With `--sandbox`, create the repo if it is missing. No effect without `--sandbox`. |

`--commit`, `-y/--yes`, and the `logout` subcommand are unchanged. `-y/--yes` combined with a destination flag is a fully non-interactive run.

## 5. Sandbox creation

When the user chooses to create a sandbox (interactive) or passes `--sandbox X --create-sandbox` for a missing repo:

- **Name:** interactive prompts for a name with default `pr-backtest-sandbox`; non-interactive uses the repo name from the `--sandbox <owner/repo>` slug.
- **Owner:** default to the **source PR's owner** (keeps private code inside the same org/account boundary — the in-boundary rule from the design discussion). Interactive lets the user edit the owner (e.g. to their own account or another org they control).
- **Visibility:** **private** always. Never create a repo more visible than private.
- **Initialization:** create empty (no auto-init) is acceptable only if opening the backtest PR in a freshly created empty repo is verified to work; otherwise initialize with a minimal commit so a default branch exists. Implementer chooses, but AC-CREATE-003 must hold.
- **API:** use the existing Octokit instance. Personal account → `repos.createForAuthenticatedUser`; org → `repos.createInOrg`. No new dependency.
- **Permission failure:** if creation returns 403 / insufficient permission (common when the source owner is an org the user cannot create repos in), do **not** fall through to writing the primary repo. Interactive: explain and re-present `A different repo…` and `Primary repo`. Non-interactive: exit 2 with a message naming the owner and the missing permission.
- **Persistence:** on success, offer (interactive) or automatically (non-interactive with `--create-sandbox`) save it as the default destination (§7).

## 6. Destination verification (pre-flight)

Verification applies to **every** chosen destination, **including the primary repo** — choosing "Primary repo" is still a write, and the token may be read-only on it. Verify the chosen destination via a single `repos.get` call, immediately after the destination is resolved and before the clone, and inspect both existence and `permissions.push`:

- **Exists and `permissions.push === true`** → proceed.
- **Missing (404)** → interactive: explain and offer `Create a sandbox repo` / `A different repo…`; non-interactive: exit 2 (or create when `--create-sandbox` and the destination is a sandbox slug).
- **Exists but `permissions.push !== true`** (token cannot write) → the token lacks write access. Show the message below; **never** silently fall back to another repo. Interactive: re-present the menu. Non-interactive: exit 2.

This single check makes three cases safe with one code path: a deleted saved sandbox (404 → re-prompt), a primary repo the token can't write (no push → clear message instead of a cryptic deep git failure), and a sandbox the token isn't scoped for.

### 6.1 Write-permission message

When the token cannot write to the chosen destination, the message must name the repo, state the missing capability, and offer the alternatives — and when a *different* destination is already known this run to be writable (e.g. the saved sandbox), name it as the suggested alternative:

```
The saved GitHub token can read but cannot create branches or open PRs in
<dest-owner>/<dest-repo> (no write access).

Fix one of these:
  • Provide a token with Contents:write + Pull requests:write on that repo
    (run `pr-backtest logout`, then re-run and paste a new token), or
  • Choose a different destination[ — e.g. your sandbox <saved-owner>/<saved-repo>,
    which this token can write to].
```

The bracketed clause is included only when such a writable alternative is known. The token value is never echoed in this or any message.

### 6.2 Token now spans up to two repos

With a non-primary destination, a single fine-grained token must cover **both**: read on the source repo (to read the PR and fetch its commits) **and** write on the destination (Contents + Pull requests). The interactive token guidance in `auth.ts` and the README must state this: a sandbox token scoped to only the sandbox cannot read a private source PR, and a token scoped to only the source cannot write the sandbox. For the Primary-repo destination, one repo's worth of access (read + write on the source) suffices, as today.

## 7. Config changes (`src/config.ts`)

Extend the persisted config with an optional default destination:

```ts
interface Config {
  token?: string;        // now optional: a destination may be saved when the
                         // token comes from env/gh and was never persisted
  username?: string;
  source?: TokenSource;
  defaultDestination?: { owner: string; repo: string };
}
```

- `readConfig` must tolerate older files that lack `defaultDestination`, and files that have a `defaultDestination` but no `token` (env/gh users who only saved a sandbox). Token resolution already guards on `cfg.token.length > 0`, so a missing token is treated as "no saved token" — preserve that.
- Add a writer that **merges** rather than overwrites: saving a default destination must not drop a saved token, and saving a token must not drop a saved destination. (Today `writeConfig` writes the whole object; a read-modify-write helper or a partial updater is required.)
- File mode stays `0600`; the merge path must re-assert `0600` exactly as the current writer does.
- `logout` deletes the whole file as today (it removes the saved destination too — acceptable; document it).

## 8. Plan display (`src/plan.ts`)

The confirmation plan already carries `targetRepo`. Make the read/write split explicit so the user sees the safety guarantee at confirmation time, e.g.:

```
Reading from:  <source-owner>/<source-repo>#<n>   (read-only)
Creating in:   <dest-owner>/<dest-repo>
  ├─ branch <baseBranch>  ← <baseSha>
  ├─ branch <headBranch>  ← <targetSha>
  └─ PR: [backtest] <title>
```

The `(read-only)` tag on "Reading from" appears **only when the destination differs from the source**. When destination == primary, the plan must not claim the source is read-only (it is about to be written); show the single repo plainly as the place both the read and the write happen. The plan must always make it unambiguous which repo will receive the branches and PR.

## 9. Exit codes

Preserve the v0 mapping (`src/index.ts` `EXIT`). Additions:

- **No destination resolvable, non-interactive** → exit 1 (bad args), alongside the existing no-token-non-interactive case.
- **`--primary` and `--sandbox` both given** → exit 1.
- **Sandbox creation/verification failure** (permission, not-writable, missing without `--create-sandbox`) → exit 2 (API error class).

No new numeric codes; reuse 1 (bad args) and 2 (API error).

## 10. Edge cases (each must be covered)

1. **Saved sandbox deleted on GitHub** → pre-flight 404 → re-prompt (interactive) / exit 2 (non-interactive). Never writes the primary repo as a fallback.
2. **Sandbox exists on GitHub but not in config** → handled by `A different repo…` (user names it; offer to save).
3. **Source owner is an org the user cannot create repos in** → creation 403 → explained, never falls back to primary.
4. **`--sandbox` points at the same owner/repo as the source** → allowed; it is equivalent to `--primary` (destination == source, `isFork` false).
4b. **Primary chosen but token is read-only on the source** → the §6.1 write-permission message fires before the clone; interactive re-prompts, non-interactive exits 2. The PR is never half-created.
4c. **Token scoped to only the sandbox, source PR is private** → reading the source PR fails first (existing 404 handling, exit 2). The README/token guidance (§6.2) must warn that a non-primary destination needs a token covering both repos.
5. **Freshly created empty sandbox** → opening the backtest PR must still succeed (AC-CREATE-003).
6. **`--create-sandbox` without `--sandbox`** → no-op (documented), or a bad-args error; pick one and assert it.
7. **Non-TTY with a saved default destination** → uses it without prompting.
8. **Token came from env/gh (no config file)** and the user saves a sandbox → a config file is created holding only `defaultDestination` (no token), and a later run still reads the destination.
9. **Duplicate backtest PR in the sandbox** → the existing `findExistingPr` / 422 handling already covers this; confirm it operates against the destination, not the source.

## 11. Security and invariants (hard requirements)

- **INV-READONLY:** when the destination is not the source, the source owner/repo is never passed to `pushBranchFromSha`, `createPullRequest`, or any repo-creation call. The source is only ever a read: `getPullRequest`, `listPullRequestCommits`, `getCommitParentSha`, and the `source` fetch remote.
- **INV-TOKEN:** the existing token-safety guarantees (VAL-CROSS-002) hold through every new path, including repo creation and destination verification: the token is never logged, never printed, never written anywhere except the `0600` config, never put in a remote URL or on a git command line.
- **INV-PRIVATE:** a created sandbox is always private.
- **INV-NO-DEP:** no new runtime dependency. Repo creation and verification use the existing Octokit instance; prompting uses the existing `prompts`.

## 12. Existing code to reuse (do not rebuild)

- **Write-elsewhere plumbing** already exists: `src/index.ts:88-102` (`destOwner`/`destRepo`/`isFork`), `:211-216` (`source` remote + fetch from source), and `pushBranchFromSha` always targeting the destination clone's `origin`. The sandbox is mechanically the current `--fork` destination; rename and wrap it, do not reimplement the clone/fetch/push.
- **Injectable-resolver pattern:** model destination resolution on `auth.ts` `resolveTokenSource(resolvers)` — a pure-ish function with injected getters (env flags, config, an `octokit`-backed verify/create, and an interactive prompt), so precedence is unit-testable without network or TTY.
- **Repo-slug parsing:** `parseRepoSlug` in `src/parseUrl.ts` already parses `owner/repo`; reuse it for `--sandbox` and the "different repo" prompt.
- **Octokit injection for tests:** `auth.ts` already injects `makeOctokit`; mirror that so creation/verification are testable with a fake.

## 13. Acceptance criteria

Grouped by area. Each line is a pass/fail assertion with a suggested Evidence vocabulary tag for the mission validation contract.

### Destination resolution
- **AC-DEST-001** Given `--primary`, the destination is the source repo and no prompt is shown. — `test(test/destination.test.ts)`
- **AC-DEST-002** Given `--sandbox owner/repo` for an existing writable repo, the destination is that repo and no prompt is shown. — `test(test/destination.test.ts)`
- **AC-DEST-003** Given both `--primary` and `--sandbox`, the tool exits 1 without writing. — `test(test/cli.test.ts)`
- **AC-DEST-004** Non-interactive (no TTY), no destination flag, no saved default → exit 1 with guidance naming `--primary`/`--sandbox`. — `test(test/destination.test.ts)`
- **AC-DEST-005** Non-interactive, no destination flag, saved default present → destination is the saved default, no prompt. — `test(test/destination.test.ts)`
- **AC-DEST-006** Resolution precedence is exactly flags → interactive(TTY) → saved-default(non-TTY) → error. — `test(test/destination.test.ts)`

### Interactive selection
- **AC-INT-001** With a saved default and a TTY, the menu offers Primary, the saved Sandbox, and "A different repo…". — `manual(run against a PR URL with a saved default)` + `test` with injected prompt.
- **AC-INT-002** With no saved default and a TTY, the menu offers Primary, "Create a sandbox repo", and "A different repo…". — `manual` + `test` with injected prompt.
- **AC-INT-003** Choosing "A different repo…" prompts for `owner/repo`, verifies it, and offers to save it as default. — `test(test/destination.test.ts)`

### Sandbox creation
- **AC-CREATE-001** Creating a sandbox produces a **private** repo via Octokit, defaulting its owner to the source owner. — `test(test/destination.test.ts)` + `grep(private in the create call)`
- **AC-CREATE-002** Creation 403 (no permission) never results in a write to the source repo; interactive re-prompts, non-interactive exits 2. — `test(test/destination.test.ts)`
- **AC-CREATE-003** A backtest PR opens successfully in a freshly created sandbox. — `manual(create-sandbox run end to end against a throwaway private repo)`
- **AC-CREATE-004** `--sandbox X --create-sandbox` creates `X` when missing and uses it; without `--create-sandbox` a missing `X` exits 2. — `test(test/destination.test.ts)`

### Verification / drift
- **AC-VERIFY-001** A saved default that 404s on GitHub is detected pre-flight; interactive re-prompts, non-interactive exits 2; the primary repo is never written as a fallback. — `test(test/destination.test.ts)`
- **AC-VERIFY-002** A non-primary destination that exists but is not writable (`permissions.push !== true`) re-prompts (interactive) / exits 2 (non-interactive) with the §6.1 message; no fallback to any other repo. — `test(test/destination.test.ts)`
- **AC-VERIFY-003** Choosing the **primary** repo when the token lacks write access to it produces the §6.1 message (not a deep git push failure) and, interactively, re-presents the menu rather than proceeding. — `test(test/destination.test.ts)`
- **AC-VERIFY-004** The write-permission check runs before the clone (a single `repos.get` reading `permissions.push`), so a write failure never reaches `cloneRepo`/`pushBranchFromSha`. — `test(test/destination.test.ts asserting call order)`
- **AC-VERIFY-005** When the failing destination is the primary and a saved sandbox is known writable this run, the §6.1 message names that sandbox as the suggested alternative. — `test(test/destination.test.ts)`

### Config persistence
- **AC-CONFIG-001** Saving a default destination preserves any saved token (merge, not overwrite). — `test(test/config.test.ts)`
- **AC-CONFIG-002** Saving a token preserves any saved default destination. — `test(test/config.test.ts)`
- **AC-CONFIG-003** `readConfig` tolerates old files without `defaultDestination` and files with a destination but no token. — `test(test/config.test.ts)`
- **AC-CONFIG-004** The config file remains mode `0600` after a destination-only save. — `test(test/config.test.ts)`

### Plan and CLI surface
- **AC-PLAN-001** When destination ≠ source, the plan shows the source tagged `(read-only)` and the destination as the write target, distinctly. — `test(test/plan.test.ts)`
- **AC-PLAN-002** When destination == source, the plan does **not** tag the source `(read-only)`; it shows the one repo as the place the read and the write both happen. — `test(test/plan.test.ts)`
- **AC-CLI-001** `--fork` no longer exists; `--primary`, `--sandbox`, `--create-sandbox` are documented in `--help`. — `grep(in src/cli.ts and README.md)` + `test(test/cli.test.ts)`

### Invariants
- **AC-INV-001** When destination ≠ source, the source owner/repo is never an argument to `pushBranchFromSha`, `createPullRequest`, or repo creation. — `test(test/destination.test.ts asserting call args)` + `grep`
- **AC-INV-002** Token safety holds through creation and verification paths (never logged/printed/in a URL/on a command line). — `test` (extend existing token-safety tests) + `grep`
- **AC-INV-003** No new runtime dependency is added. — `grep(package.json dependencies unchanged)` + `tsc-clean`

### Quality gates
- **AC-GATE-001** `tsc` is clean. — `tsc-clean`
- **AC-GATE-002** Lint is clean. — `lint-clean`
- **AC-GATE-003** README documents the destination model (primary vs sandbox), the read-only guarantee, and the new flags. — `manual(read README)` + `grep`

## 14. Suggested decomposition (for the mission orchestrator)

One milestone. Features execute top-down so preconditions are satisfied:

1. **config-destination** — extend `Config`, add merge-save + tolerant read. (AC-CONFIG-*) `fulfills` the config assertions.
2. **destination-resolve** — pure resolver with injected getters: flags, config, octokit verify/create, prompt. (AC-DEST-*, AC-VERIFY-*, AC-INV-001) Foundational; the interactive and creation pieces plug into it.
3. **sandbox-create** — Octokit creation (private, source-owner default, permission handling). (AC-CREATE-*)
4. **interactive-menu** — the `prompts` selection and "different repo" / "remember as default" sub-flows. (AC-INT-*)
5. **cli-and-index** — replace `--fork` with `--primary`/`--sandbox`/`--create-sandbox`, wire the resolver into `runBacktest`, exit codes. (AC-CLI-001, AC-DEST-003)
6. **plan-and-docs** — plan read/write split + README. (AC-PLAN-001, AC-GATE-003)

Foundational features (config, resolver) may carry `"fulfills": []` for assertions that only the user-facing leaf truly completes; the orchestrator assigns each assertion to exactly one feature per the coverage invariant.
