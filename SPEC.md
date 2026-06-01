# PR Backtest CLI — Specification

A standalone open-source CLI that recreates a GitHub PR at a chosen commit so PR-review bots (e.g., Macroscope) can review the code as it existed at that moment.

Extracted from the internal Macroscope Code Review Studio's PR simulator (`app/api/create-pr/route.ts`), stripped of all auth, database, prospector, and email-generation concerns.

---

## 1. Goals

- `pr-backtest <pr-url>` creates a new PR in the same repo whose diff equals the original PR's diff at a chosen commit.
- Works on private repos.
- Reviewer-agnostic: just creates the PR. If a review bot is installed (Macroscope or otherwise), it will review the new PR automatically.
- Minimal setup: a GitHub PAT and `npm install -g`.
- Safe by default: shows the user the plan and asks for confirmation before doing anything destructive.

## 2. Non-goals

- No webapp, no database, no auth, no prospector, no email generation, no Apollo, no caching beyond a single git clone.
- No batch backtesting (one PR per invocation).
- No comments posted back to the original PR.
- No fork management. New branches are isolated from `main` — `main` is never touched, never checked out, never modified. Users who want extra isolation can manually fork their repo first.

---

## 3. CLI Surface

### Install
```bash
npm install -g pr-backtest
# or:
npx pr-backtest <pr-url>
```

### Usage
```bash
pr-backtest <pr-url> [--commit <ref>] [-y]
```

### Arguments and flags
| Arg/Flag | Required | Default | Description |
|---|---|---|---|
| `<pr-url>` | Yes | — | Full GitHub PR URL, e.g. `https://github.com/acme/api/pull/123` |
| `--commit <ref>` | No | `initial` | `initial` (first non-merge commit of the PR) or a full SHA. The created PR's head will be at this commit; its base will be the commit's parent. |
| `-y`, `--yes` | No | `false` | Skip the confirmation prompt. For scripting. |
| `--fork <owner/repo>` | No | — | Create the backtest branches and PR in this fork instead of the PR's own repo. The PR is still **read** from the URL's repo; only the **writes** (branch pushes, PR creation) are redirected to the fork. See §5 "Same-repo by default, optional `--fork`". |

### Subcommands
| Command | Description |
|---|---|
| `pr-backtest <pr-url>` | Run a backtest (the main command). |
| `pr-backtest logout` | Delete the saved token from the config file. |

### Authentication

On first run, if no token is configured, the tool prompts interactively. If `gh` CLI is installed and authenticated locally, the tool offers to reuse its token (no new credentials to create or store):

```
No GitHub token configured.

I see you have `gh` CLI installed and authenticated as @stevem.
Use that token? [Y/n]
```

If `gh` isn't available, the tool walks the user through creating a fine-grained PAT (narrower scope than a classic `repo` token):

```
No GitHub token configured.

pr-backtest needs a GitHub token with these permissions for one specific repo:
  • Contents:      Read & write   (push backtest branches)
  • Pull requests: Read & write   (read PR data, open the simulated PR)
  • Metadata:      Read           (required for all tokens)

Recommended: create a fine-grained token scoped to just this one repo:
  https://github.com/settings/personal-access-tokens/new

(If you prefer a classic token, use https://github.com/settings/tokens/new?scopes=repo&description=pr-backtest — note this grants access to all your private repos.)

Paste your token: ████████████████████

→ Validating...
✓ Authenticated as @stevem
✓ Token saved to ~/.config/pr-backtest/config.json (mode 0600)
```

After paste, the tool calls `octokit.users.getAuthenticated()` to validate and surface the username. Bad tokens fail fast.

**Token resolution order** (first match wins):
1. `GITHUB_TOKEN` env var (takes precedence — useful for CI / scripting)
2. Config file at `$XDG_CONFIG_HOME/pr-backtest/config.json` (defaults to `~/.config/pr-backtest/config.json` on macOS/Linux, `%APPDATA%\pr-backtest\config.json` on Windows)
3. `gh auth token` (if `gh` is installed and authenticated; tool prompts before using)
4. Interactive prompt (only if all above unavailable, and stdin is a TTY)

If no token is set and stdin is not a TTY (e.g., piping output, CI without `GITHUB_TOKEN`), the tool exits `1` with a message pointing to the setup instructions.

Config file format:
```json
{
  "token": "github_pat_...",
  "username": "stevem",
  "source": "fine-grained" | "classic" | "gh-cli"
}
```

Config file is written with mode `0600` (owner read/write only). On read, the tool checks permissions and warns if they've been loosened.

### First-run user journey

```
$ npm install -g pr-backtest
[npm output]

$ pr-backtest https://github.com/acme/api/pull/123
[interactive token prompt as shown above, only on first run]

[plan + confirm prompt]

[execution]

https://github.com/acme/api/pull/451
```

Subsequent runs skip the token prompt and go straight to the plan-and-confirm step.

### Default behavior: plan + confirm
Every invocation (unless `-y` is passed) prints a plan and asks for confirmation before doing anything that modifies state. This collapses what would otherwise be separate `--dry-run` and `--verbose` flags into one default.

Sample:
```
$ pr-backtest https://github.com/acme/api/pull/123

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem
Target:  a1b2c3d (initial commit) "Initial implementation"
Base:    f0e9d8c (parent of target)

Plan:
  1. Clone acme/api into /tmp/pr-backtest-xxxxx
  2. Fetch commits a1b2c3d and f0e9d8c from origin
  3. Push f0e9d8c → acme/api:backtest-pr123-base
  4. Push a1b2c3d → acme/api:backtest-pr123-head
  5. Open PR: backtest-pr123-head → backtest-pr123-base

Continue? [y/N]
```

### Exit codes
- `0` — PR created (or user declined confirmation)
- `1` — Bad arguments
- `2` — PR not found / GitHub API error
- `3` — Git operation failed (clone, fetch, push)
- `4` — A PR already exists for these branches (prints existing URL)

### Output
On success, the final line of stdout is the URL of the created PR. All progress and plan messages go to stderr, so the URL is pipe-friendly:
```bash
URL=$(pr-backtest https://github.com/acme/api/pull/123 -y)
```

---

## 4. Behavior — what the tool actually does

### Step-by-step
1. **Parse PR URL** → `(owner, repo, prNumber)`.
2. **Fetch PR via GitHub API** (`GET /repos/{owner}/{repo}/pulls/{number}`) and its commits (`GET /repos/{owner}/{repo}/pulls/{number}/commits`).
3. **Resolve target commit** from `--commit`:
   - `initial` (default) → first non-merge commit in the PR
   - SHA → use directly (must be reachable from the PR)
4. **Resolve base commit** → parent of the target commit (`getCommit(targetSha).parents[0].sha`).
5. **Check for existing PR** with the planned head/base branch combo. If one exists, print its URL and exit `4`.
6. **Print the plan and prompt for confirmation** (unless `-y`). Exit `0` if user declines.
7. **Clone the upstream repo** to a temp directory.
8. **Fetch target and base commits** from origin.
9. **Push the two commits as branches** (no local checkout needed — `git push` accepts `<sha>:refs/heads/<branch>`):
   - `<base-sha>:refs/heads/backtest-pr<N>-base`
   - `<target-sha>:refs/heads/backtest-pr<N>-head`
10. **Open the PR** via GitHub API, head → base.
11. **Print PR URL** to stdout.
12. **Clean up temp dir.**

### With `--fork <owner/repo>`
The PR is still **read** from the URL's repo (steps 1–4 are unchanged — `getPullRequest` / `listCommits` / `getCommit` all hit the original repo). Only the **writes** are redirected to the fork:
- Step 5 (existing-PR check), step 7 (clone), step 9 (branch pushes), and step 10 (PR creation) all target the **fork**, not the original repo.
- Step 8 fetches the target/base commits from a `source` remote pointing at the original repo (added to the fork clone), because a fresh fork does not contain the PR's branches/refs — only the shared object network. This is why the token needs **read** on the original repo and **write** on the fork.
- The original repo is therefore never written to: no branches, no PR. See §5.

### Safety properties
- `main` is never checked out, written to, or pushed to.
- The temp clone directory is always removed on exit (success or failure), via a `finally` block and `process.on('exit')` handler.
- Pre-flight existing-PR check prevents accidentally creating duplicates on re-runs.

---

## 5. Key design decisions

### Same-repo by default, optional `--fork`
By default the tool pushes branches and opens the simulated PR in the PR's own repo. The `backtest-pr*` branches are isolated from `main` — opening a PR doesn't merge anything — so for most users (who own the repo) this is fine.

For users who want the writes to land somewhere the tool's token can't reach their real repo, `--fork <owner/repo>` redirects all writes to a fork. **The key intent: read from the original, write to the fork.** The PR data and its commits are read from the URL's repo via the API; the branches and PR are created in the fork. The commits are fetched from a `source` remote (the original repo) into the fork clone — a plain fork doesn't carry the PR's refs, only the shared git object network, so a SHA-targeted fetch from `source` is the reliable path.

Access implications, stated honestly:
- The token needs **read** on the original repo (to read the PR + fetch the commits) and **write** on the fork (to push branches + open the PR).
- If the original repo is **public**, a token scoped to *only the fork* is enough — public reads don't require access on the source. This is the original Macroscope simulator's case (public OSS repos), and the strongest isolation story: the token literally cannot write to the source.
- If the original repo is **private**, the token must also have read on it. The blast radius is still smaller than write-on-source, but it is not "the token can't touch the real repo at all."

The earlier version of this spec said "no tool-level flag needed; just point the tool at the fork's URL." That was wrong: forking does not copy PRs, so the fork has no PR to read, and a fork-scoped token cannot write to the original repo named in an upstream PR URL. `--fork` is the correct mechanism.

### Direct branch-from-SHA, no cherry-pick
The original simulator had a 3-strategy fallback (merge-commit → pr-head-fetch → cherry-pick) because it was always replaying the *full* PR state, and squash/rebase merges made finding the right SHA pair tricky. Our scope is different — we target a single specific commit, not "the whole PR state."

GitHub preserves `refs/pull/{N}/head` indefinitely, so a single fetch-by-SHA covers:
- Open PRs
- Merged PRs (merge commit, squash, rebase — all preserved)
- Force-pushed PRs (old commits remain accessible)

The only realistic failure modes are when the SHA itself has been deleted from GitHub (repo transferred/deleted, or extremely old force-pushes where GitHub eventually GCs). In those cases, cherry-pick can't help either — both strategies need the SHAs to be fetchable. Skip the fallback ladder; fail fast with a clear error and manual-fallback instructions (see §6.5).

### No cross-reference stripping
The original tool used `git commit --amend` + regex to rewrite `#123` → `PR-123` so commit pushes wouldn't ping the original PR's authors. Customers running this on their own repo *are* the authors, so cross-references are fine. Drop the rebase-with-exec dance entirely — it's the most fragile part of the original code.

### No `@macroscope review` auto-comment
Macroscope (and most PR-review bots) auto-runs on new PRs. Posting a comment would make the tool Macroscope-specific. Users with no auto-trigger can add the comment manually.

### No database
The original used SQLite to cache fork existence, PR existence, and cached-repo lists. Not needed for a one-shot CLI; the GitHub API check is cheap enough to run every time.

### Plan + confirm by default
Safer than `--dry-run` as a separate flag (which users forget to use), and clearer than `--verbose` (which usually just dumps git output). Showing the plan up-front gives the user everything they need to verify the SHAs, branch names, and target before any state changes. `-y` skips it for scripting.

---

## 5.5 Security

A standalone open-source CLI tool that touches private code and holds a GitHub token will get scrutiny from security-conscious customers. The tool must be honest about what it does and provably narrow in what it can do.

### What the tool sends over the network

The only outbound hosts are:
- `api.github.com` — GitHub REST API calls (read PR data, create simulated PR)
- `github.com` — git clone, fetch, and push over HTTPS

There is **no telemetry, no analytics, no error reporting service, and no calls to any Macroscope server or other third party.** This is enforced by the dependency list — see `package.json` for the complete list of network-capable dependencies.

The README must state this explicitly, in a `## Privacy` section, and the source must be auditable (it is — the whole tool is ~570 LOC of plain TypeScript).

### What the token can do

The recommended fine-grained PAT permissions are the minimum needed to function:
- Contents: Read & write — required to push the two backtest branches
- Pull requests: Read & write — required to read the original PR and open the simulated one
- Metadata: Read — required for any PAT

Scoped to a single repository. Cannot access other repos, cannot create repos, cannot impersonate the user across GitHub, cannot read or modify org settings.

If the user picks a classic `repo`-scoped token instead, the blast radius is wider (all the user's private repos), but the tool itself still only ever touches the one repo named in the PR URL.

### Where the token is stored

- Config file: `~/.config/pr-backtest/config.json` (macOS/Linux) or `%APPDATA%\pr-backtest\config.json` (Windows). File mode `0600`.
- Never logged, never printed to stderr, never written to the temp clone directory.
- `pr-backtest logout` deletes the config file.

### Revocation

If a token is compromised, the user revokes it at https://github.com/settings/tokens (classic) or https://github.com/settings/personal-access-tokens (fine-grained). Because fine-grained PATs are scoped to one repo, the blast radius of a leaked token is contained.

### Supply chain

The tool is published to npm under a clear maintainer name. Users who don't want to trust npm can clone the GitHub repo and `npm install` locally instead. The `package.json` dependency list is short and pinned, and each dependency is well-known (`commander`, `simple-git`, `@octokit/rest`, `prompts`, `chalk`). No obscure transitive packages.

---

## 6. Implementation plan

### Stack
- Node.js 18+, TypeScript
- `commander` for CLI parsing
- `@octokit/rest` for GitHub API
- `simple-git` for git operations
- `prompts` (or `readline`) for the y/N confirmation
- `chalk` for terminal colors

### File layout
```
pr-backtest/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE                    # MIT
├── src/
│   ├── cli.ts                 # commander entrypoint, subcommand routing
│   ├── index.ts               # main runBacktest(opts) function
│   ├── auth.ts                # token resolution: env → config file → interactive prompt
│   ├── config.ts              # XDG-aware config file read/write
│   ├── github.ts              # Octokit wrappers
│   ├── git.ts                 # simple-git wrappers
│   ├── resolveCommit.ts       # --commit flag → SHA
│   ├── parseUrl.ts            # PR URL → {owner, repo, number}
│   ├── plan.ts                # build + render the plan, prompt for confirmation
│   └── log.ts                 # stderr progress logging
├── test/
│   ├── parseUrl.test.ts
│   ├── resolveCommit.test.ts
│   ├── auth.test.ts
│   └── integration.test.ts    # gated on GITHUB_TOKEN
└── bin/
    └── pr-backtest            # shebang wrapper → dist/cli.js
```

### 6.5 Error messages for unfetchable commits

When `git fetch origin <sha>` fails for either the target or its parent, surface a specific, actionable error rather than the raw git stderr:

```
✗ Could not fetch commit a1b2c3d from origin.

This usually means one of:
  • The commit was deleted from GitHub (very old force-push, repo transfer/delete)
  • The PR is from a fork whose owner deleted their branch
  • Your token doesn't have permission to read this commit

If the commit still exists locally somewhere (e.g., on a developer's machine),
you can manually push it as a branch and re-run:

  git push origin <sha>:refs/heads/backtest-pr<N>-head
  git push origin <sha>^:refs/heads/backtest-pr<N>-base

Then open a PR between those branches in the GitHub UI.
```

The error message includes the manual git fallback so users hitting an edge case have a clear path forward without filing an issue.

### Approximate LOC
- `cli.ts`: ~60
- `index.ts`: ~150
- `auth.ts`: ~70
- `config.ts`: ~40
- `github.ts`: ~70
- `git.ts`: ~50
- `resolveCommit.ts`: ~25
- `parseUrl.ts`: ~15
- `plan.ts`: ~60
- `log.ts`: ~30

**Total: ~570 LOC.** Down from the original ~1600.

---

## 7. Example invocations

```bash
# Default: initial commit, show plan, confirm
pr-backtest https://github.com/acme/api/pull/123

# Specific commit
pr-backtest https://github.com/acme/api/pull/123 --commit a1b2c3d

# Skip confirmation (scripting)
pr-backtest https://github.com/acme/api/pull/123 -y
```

---

## 8. Testing

### Unit tests
- `parseUrl.ts` — valid URLs, invalid URLs, trailing slashes, query strings
- `resolveCommit.ts` — `initial`, full SHA, invalid input

### Integration test
Gated on `GITHUB_TOKEN`. Runs against a known fixture PR in a public test repo. Asserts:
- The created PR's diff matches the expected diff for the target commit
- Branches are named correctly
- Cleanup happens (temp dir gone)

`TEST_FIXTURE_REPO` env var lets contributors point at their own test repo.

### Manual smoke test before v0
1. Public PR + a public test repo, end-to-end.
2. Private repo, default options (initial commit).
3. `--commit <sha>` with a specific commit from later in the PR.
4. Run twice → second invocation exits `4` with existing PR URL.

---

## 9. README outline (for the generated repo)

1. **What this does** — one paragraph + screenshot of CLI output
2. **The problem it solves** — "Replay an old PR at a chosen commit so your PR-review bot can review it as if it were brand new. Useful for backtesting reviewer-bot quality against historical PRs."
3. **Install** — `npm install -g pr-backtest`
4. **Setup** — PAT scopes (recommend fine-grained, narrow permissions), `GITHUB_TOKEN` env var
5. **Usage** — examples from §7
6. **How it works** — 4-bullet summary of §4
7. **Safety** — emphasis: `main` is never touched; branches are isolated; plan-and-confirm by default
8. **Privacy & security** — explicit: no telemetry, no calls to anything except api.github.com / github.com, token stored locally with mode 0600, source is auditable. Mirror §5.5.
9. **Limitations**
   - One PR at a time
   - Requires push access to the repo (or manually fork first)
   - Won't work if the PR's base branch has been force-pushed and the target commit's parent is no longer reachable
10. **Contributing**
11. **License** — MIT

---

## 10. Open questions / followups (post-v0)

- Batch mode: file with one PR URL per line.
- Cleanup command: `pr-backtest cleanup <repo>` deletes all `backtest-pr*` branches and closes associated PRs.
- `--review-with <bot>` flag for bots that don't auto-trigger.
- GitLab/Bitbucket support.

---

## 11. Definition of done

- `npm install -g .` from the repo gives you a working `pr-backtest` command.
- Running against a private PR you own creates a new PR whose diff matches the chosen commit's state.
- README covers install, setup, usage, safety, and limitations.
- Unit tests for `parseUrl` and `resolveCommit` pass.
- At least one integration test passes against a public fixture PR.
- Repo has MIT license and is ready to push to GitHub.
