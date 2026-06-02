# pr-backtest

Recreate a GitHub pull request at a chosen commit, so a PR-review bot can review the code exactly as it existed then. Point it at a PR URL and it opens a fresh PR whose diff matches that commit. Your `main` branch is never touched.

**Why:** backtest a PR-review bot against history. Take a PR whose outcome you already know, replay it at its original commit, and see how your bot does on a "brand new" PR.

**Security:** pr-backtest only ever talks to GitHub — `api.github.com` and `github.com`, nothing else. No telemetry, no analytics, no third-party calls. Your token stays on your machine (read from `GITHUB_TOKEN` / `gh`, or saved locally with `0600` permissions) and is never sent anywhere except GitHub.

## Requirements

Node.js `>=18`.

## Install

```bash
npm install -g pr-backtest
# or run it without installing:
npx pr-backtest <pr-url>
```

## Setup

There is no separate setup step. The first time you run `pr-backtest <pr-url>` in an interactive terminal, it resolves a GitHub token in this order:

1. **`GITHUB_TOKEN` environment variable** — if this env var is set, its value is used and is never written to the config file. Set it in your shell with `export GITHUB_TOKEN=ghp_...` (or prefix a single run: `GITHUB_TOKEN=ghp_... pr-backtest <pr-url>`). This is the path for CI and scripting (non-interactive runs require it).
2. **Saved config** — a token saved automatically on a previous run when you pasted one (see step 4), stored at `~/.config/pr-backtest/config.json`, mode `0600`.
3. **`gh` CLI** — if you already use the [GitHub CLI](https://cli.github.com) and are logged in, pr-backtest offers to reuse that login, so you don't have to create a token at all.
4. **Paste a token** — otherwise it prompts you to paste one (input is masked) and offers to save it for next time.

So if you already have `gh` authed or `GITHUB_TOKEN` exported, you're ready with zero token setup. Otherwise, create a fine-grained token with the permissions in [Recommendations](#recommendations). Run `pr-backtest logout` to clear a saved token (and any saved default destination).

## Usage

```bash
# Recreate at the PR's initial (first non-merge) commit — prints a plan, asks to confirm
pr-backtest https://github.com/acme/api/pull/123

# Recreate at a specific commit (head at that commit, base at its parent)
pr-backtest https://github.com/acme/api/pull/123 --commit a1b2c3d

# Skip the confirmation prompt (for scripting)
pr-backtest https://github.com/acme/api/pull/123 -y

# Land the backtest in the PR's own repo, no prompt
pr-backtest https://github.com/acme/api/pull/123 --primary

# Land the backtest in a separate sandbox repo you control
pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox

# Create that sandbox first if it doesn't exist yet (private)
pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox --create-sandbox

# Remove the saved token and default destination
pr-backtest logout
```

### Commands

| Command | Description |
|---|---|
| `pr-backtest <pr-url> [options]` | Recreate the PR at a chosen commit and open a backtest PR. |
| `pr-backtest logout` | Delete the saved config (GitHub token and any saved default destination). |

On first run it prompts for a GitHub token (and offers to reuse your `gh` CLI login if you have one). The new PR's URL is printed to stdout. Run `pr-backtest logout` to remove a saved token (this also deletes the saved default destination — see [Destination](#destination)).

Running against a **Primary** destination (the PR's own repo) prints a plan like this:

```
$ pr-backtest https://github.com/acme/api/pull/123 --primary

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem
Target:  a1b2c3d (initial commit)
Base:    f0e9d8c (parent of target)

Plan:
  1. Clone acme/api into a temp directory
  2. Fetch commits a1b2c3d and f0e9d8c from origin
  3. Push f0e9d8c → acme/api:backtest-pr123-base
  4. Push a1b2c3d → acme/api:backtest-pr123-head
  5. Open PR in acme/api: backtest-pr123-head → backtest-pr123-base

Continue? [y/N] y

https://github.com/acme/api/pull/451
```

A **Sandbox** destination reads the PR from its own repo but writes everything to the repo you choose. The source is tagged `(read-only)` and the write target is named on an `Into:` line:

```
$ pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem   (read-only — source is never written)
Target:  a1b2c3d (initial commit)
Base:    f0e9d8c (parent of target)
Into:    myuser/pr-backtest-sandbox (sandbox — branches and PR are created here)

Plan:
  1. Clone myuser/pr-backtest-sandbox into a temp directory
  2. Fetch commits a1b2c3d and f0e9d8c from source (acme/api)
  3. Push f0e9d8c → myuser/pr-backtest-sandbox:backtest-pr123-base
  4. Push a1b2c3d → myuser/pr-backtest-sandbox:backtest-pr123-head
  5. Open PR in myuser/pr-backtest-sandbox: backtest-pr123-head → backtest-pr123-base

Continue? [y/N] y

https://github.com/myuser/pr-backtest-sandbox/pull/12
```

## Destination

pr-backtest always **reads** the PR from its own repo (the source). The branches and the simulated PR are **written** to a *destination* you choose up front. There are two kinds:

- **Primary** — the PR's own repo. The source and the destination are the same repo, so the backtest lands right next to the original PR.
- **Sandbox** — a separate repo you control. The source repo is read but never written; all writes land in the sandbox. A sandbox keeps a repo you care about completely untouched, and lets you point a review bot at a throwaway repo.

**Read-only guarantee:** the repository a PR is read from is **never written to** unless you explicitly choose it as the destination (Primary). A sandbox destination only ever reads the source.

When you run without a destination flag in a terminal, pr-backtest asks once where the simulated PR should go (Primary, a saved sandbox, create a sandbox, or a different repo) and offers to remember a sandbox as your default. Non-interactively (or with a flag) it resolves without prompting.

### Flags

| Flag | Meaning |
|---|---|
| `--primary` | Land the simulated PR in the PR's own repo (no prompt). |
| `--sandbox <owner/repo>` | Land the simulated PR in this repo (no prompt). |
| `--create-sandbox` | With `--sandbox`, create the repo (private) if it is missing. No effect without `--sandbox`. |

`--primary` and `--sandbox` are mutually exclusive. `--create-sandbox` on its own is a no-op.

`pr-backtest logout` deletes the whole config file — including any saved default sandbox destination, not just the token.

## Live activity trace

pr-backtest shows you what it is doing as it does it. The whole point is trust: you can watch that it only ever **reads** the source PR, only **writes** the destination you chose, and only ever talks to `api.github.com`.

**Default view.** Each operation prints a friendly `✓` completion marker as it finishes (a sandbox run, which also shows the `source` remote step):

```
✓ Authenticated as @octocat
✓ Verified destination  github.com/octocat/pr-backtest-sandbox
✓ Read PR github.com/acme/api#123  "Add retry logic to webhook handler"
✓ Cloning github.com/octocat/pr-backtest-sandbox
✓ Adding source remote github.com/acme/api
✓ Fetching f0e9d8c from source
✓ Fetching a1b2c3d from source
✓ Pushing f0e9d8c → backtest-pr123-base
✓ Pushing a1b2c3d → backtest-pr123-head
✓ Opened backtest PR
✓ Backtest PR created.
```

On a terminal, a slow step (clone/fetch/push) first shows an in-progress line that is replaced in place by its completion line; piped to a file, only the completion line is written. All of this goes to **stderr** — stdout stays exactly the final PR URL, so `pr-backtest … | pbcopy` still works.

**`--verbose`.** Add `--verbose` to also see, in real time, one dim line per **GitHub API request** and per **git command**, each with method/path (or argv) and an elapsed time:

```bash
pr-backtest https://github.com/acme/api/pull/123 --verbose
```

```
→ GET   /repos/acme/api/pulls/123  200  142ms
$ git clone --no-checkout https://x-access-token@github.com/octocat/pr-backtest-sandbox.git <tmp>/repo  1100ms
$ git remote add source https://x-access-token@github.com/acme/api.git  18ms
$ git fetch source f0e9d8c  312ms
$ git fetch source a1b2c3d  298ms
$ git push origin f0e9d8c:refs/heads/backtest-pr123-base  640ms
$ git push origin a1b2c3d:refs/heads/backtest-pr123-head  635ms
→ POST  /repos/octocat/pr-backtest-sandbox/pulls  201  301ms
```

Each git command shows the real argv (the token never appears — see below); each API line shows method, path, status, and elapsed time. Elapsed times are always rendered in whole milliseconds.

`--verbose` is off by default and has no short alias (`-v` is `--version`).

**The displayed git commands are the real ones, and they carry no token.** pr-backtest hands your token to git through `GIT_ASKPASS` (an environment-based credential helper) — never in the remote URL and never on the command line. So the command shown is exactly the command run, and it is safe to share: the clone URL contains only the non-secret `x-access-token@` username, with no token in it. As a final safety net every trace line — API or git, default or verbose — is passed through a redaction filter that scrubs your token even if some upstream string ever carried it.

## Recommendations

**Use a fine-grained token scoped to just the repo(s) you write to.** Create one at <https://github.com/settings/personal-access-tokens/new> with these permissions:

| Permission    | Access       |
|---------------|--------------|
| Contents      | Read & write |
| Pull requests | Read & write |
| Metadata      | Read         |

A token like this can't reach your other repos or touch org settings. For `--create-sandbox`, the token also needs permission to create repositories for the destination owner.

**A non-primary destination needs a token spanning two repos.** When the destination is a sandbox (not the PR's own repo), one token must cover **both**:

- **READ** on the source repo (to read the PR and fetch its commits), and
- **WRITE** on the destination repo (Contents + Pull requests).

A token scoped to only the sandbox can't read a private source PR; a token scoped to only the source can't write the sandbox. If the source repo is **public**, read access is implicit and a token with write on the sandbox is enough. For a **Primary** destination, one repo's worth of access (read + write on the source) is all you need.

**When you need a second token (the two-token model).** A GitHub *fine-grained* token is bound to exactly one resource owner. So when the source and the sandbox sit under **different owners** — the common case for testing a private company PR in a sandbox under your own account — **no single fine-grained token can cover both**. That is when pr-backtest splits the work across two tokens:

- a **read-only** token for the **source** owner — reads the PR and fetches its commits, and needs **no write access anywhere**, and
- a **write** token for the **destination** owner — Contents + Pull requests write on the sandbox (plus repo-creation rights for `--create-sandbox`).

The source is *only ever read* with the read-only token, and the write token *only ever writes* the destination — the read/write split is the trust boundary. A single token still covers both when it happens to span both owners (a classic PAT, or a fine-grained token scoped to all the repos involved); pr-backtest detects this and never asks for a second token it doesn't need. When the run does use two distinct tokens, the confirmation plan notes it: the source line is tagged `(read-only token)` and the `Into:` line `(write token)`.

To run a cross-owner `--sandbox <owner/repo>` non-interactively, set **`GITHUB_SOURCE_TOKEN`** to the read-only source token; `GITHUB_TOKEN` is then used for the write/destination and `GITHUB_SOURCE_TOKEN` for reading the source. In a terminal, pr-backtest instead prompts for the missing token in-flow with the exact scope it needs.

**Personal vs org sandbox — a trade-off.** A sandbox under **your personal account** is the lowest-fuss path (you can always create repos there), but the company's code lands in a repo under your personal account — an egress consideration to weigh. A sandbox **inside the org** keeps the code within the org boundary, but you need org repo-creation rights to make the sandbox there. Pick whichever matches your compliance posture; cross-owner (personal) sandboxes are the case that triggers the two-token split above.

## Exit codes

The tool exits with a stable code so it can be wired into CI:

| Code | Meaning |
|---|---|
| `0` | Success, or the user declined the confirmation prompt (no changes made). |
| `1` | Bad args — invalid PR URL, invalid `--commit`, both `--primary` and `--sandbox`, or no token in a non-interactive run. |
| `2` | GitHub API error — PR not found, auth rejected, or the destination is missing / not writable. |
| `3` | A git operation failed (clone / fetch / push). |
| `4` | A backtest PR already exists for the planned branches. The existing PR's URL is printed to stdout — a useful CI signal. |

Because exit `4` prints the existing PR's URL to stdout, a re-run is idempotent: a script can treat exit `0` and exit `4` alike and read the PR URL from stdout in both cases.

## Limitations

- **Deleted or unreachable commits.** If the target or base commit can no longer be fetched — the commit was deleted (an old force-push, a repo transfer/delete), the PR came from a fork whose owner deleted their branch, or your token can't read the commit — the run fails (exit `3`) with the two manual `git push` lines you can use to recreate the branches yourself.
- **No diff between the two commits.** If the target commit and its parent produce no difference, GitHub rejects the empty PR (422) and the tool exits `2` rather than opening a no-op PR.
- **PRs with more than 250 commits.** The GitHub API lists only the first 250 commits of a PR. For a PR larger than that, `--commit initial` still works (the first commit is always listed), but a `--commit <sha>` pointing at a commit in the unlisted tail is reported as not matching any commit in the PR; push that commit as a branch manually instead.

## License

MIT
