# pr-backtest

Recreate a GitHub pull request — all of its commits — so a PR-review bot can review the code exactly as the PR presented it. Point it at a PR URL and it opens a fresh PR whose diff matches the original's, from the PR's merge-base up to its head. Your `main` branch is never touched.

**Why:** backtest a PR-review bot against history. Take a PR whose outcome you already know, replay it at its original commit, and see how your bot does on a "brand new" PR.

**Security:** pr-backtest only ever talks to GitHub — `api.github.com` and `github.com`, nothing else. No telemetry, no analytics, no third-party calls. Your token stays on your machine (read from `GITHUB_TOKEN` / `GITHUB_SOURCE_TOKEN`, or saved locally with `0600` permissions) and is never sent anywhere except GitHub.

## Requirements

Node.js `>=18` and a `git` binary on your `PATH` (the tool shells out to `git` for clone/fetch/push).

## Install

```bash
npm install -g pr-backtest
# or run it without installing:
npx pr-backtest <pr-url>
```

### Updating a source install

If you installed from a local clone (`npm install -g .`), the global copy is a
snapshot — a `git pull` alone does not update it. From the repo root:

```bash
npm run update     # git pull --ff-only, install deps, rebuild, reinstall globally
```

Or, when you already have the changes locally and only need to rebuild and
reinstall the global copy:

```bash
npm run reinstall  # rebuild dist/ and reinstall globally
```

## Setup

There is no separate setup step. **In a terminal the tool asks about your GitHub login first**, then asks where the backtest PR lands — see [Guided setup](#guided-setup-auth-first) below. Only then does it resolve the exact token(s) the chosen destination needs. The source is only ever *read* for a Sandbox; see [Destination](#destination).

A backtest needs exactly two capabilities: **read** the source and **write** the destination. One token may provide both, or you may split them across two; the tool detects which you gave rather than predicting it.

### Guided setup (auth-first)

In an interactive terminal pr-backtest walks an **auth-first** flow before any plan:

1. **Inherited login offer.** It looks for a GitHub credential the terminal already has (via `git credential` and the `gh` CLI). If it finds one, it offers it by name — *"Use your existing GitHub login? [Y/n]"* (defaults to yes). No token is ever printed; only the `@login` is named.

2. **If you accept the login (YES):** it asks *"Where should the backtest PR land?"* with two options:
   - **Original repo** — write the backtest branches and PR straight into the PR's own repo.
   - **A new sandbox repo** — the tool **auto-creates** a private repo `<owner>/<repo>-backtest` (you can edit the name) to hold the backtests, reading the source read-only. If your login can't create repos in that owner, it offers to land in the original repo instead.

3. **If you decline, or no login is detected (NO / scoped):** it asks *"Land the backtest PR in the original source repo? [Y/n]"*:
   - **Yes** → Primary: branches and PR go in the source repo using one read + write token.
   - **No** → you **pre-create** a private sandbox repo yourself, enter it when prompted, then paste two tokens: a read-only **source** token first, then a read + write **destination** token. The source is only ever read.

Non-interactive runs and runs with a destination flag skip the prompts entirely and resolve from env vars / saved config / flags (see below).

**Two environment variables (owner-agnostic):**

- **`GITHUB_TOKEN`** — the destination/write token. It also reads the source when it covers the source too (the single-PAT case). For a **Primary** destination it is the one read + write token. Set it with `export GITHUB_TOKEN=github_pat_...` (or prefix a single run: `GITHUB_TOKEN=github_pat_... pr-backtest <pr-url>`). Non-interactive runs require it.
- **`GITHUB_SOURCE_TOKEN`** — optional read-only source token. When set, it reads the source and `GITHUB_TOKEN` only writes the destination. This is the quarantined two-token setup (the source token can be scoped read-only, so a write to the source is impossible by scope).

Per-capability resolution order (first match that validates wins; no owner logic, no source-visibility probe):

- **Write/destination token:** `GITHUB_TOKEN` env → saved `destinationToken` → interactive paste.
- **Read/source token:** `GITHUB_SOURCE_TOKEN` env → saved `sourceToken` → the resolved write token *iff* it can read the source → interactive paste.

A pasted token is saved automatically to `~/.config/pr-backtest/config.json` (mode `0600`) so a later run resolves it without prompting. In a terminal, a missing token is prompted for in-flow with the exact scope it needs; non-interactively, a missing token exits `1` naming the relevant env var. Otherwise, create a fine-grained token with the permissions in [Recommendations](#recommendations). Run `pr-backtest status` to see what is saved, and `pr-backtest logout` to clear it (tokens and any saved default destination).

## Usage

```bash
# Recreate the whole PR — all commits, base..head — prints a plan, asks to confirm
pr-backtest https://github.com/acme/api/pull/123

# Recreate the PR only up to a commit (all commits up to it; base stays the merge-base).
# Useful to replay the PR as it stood before later fix-up commits.
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
| `pr-backtest <pr-url> [options]` | Recreate the PR (all commits by default) and open a backtest PR. |
| `pr-backtest status` | Print the saved source/destination token logins + types and the default destination. Never prints a token value; makes no network call. |
| `pr-backtest logout` | Delete the saved config (both token slots and any saved default destination). |

On first run in a terminal it offers your existing GitHub login, then asks where the backtest PR lands (see [Guided setup](#guided-setup-auth-first)) and resolves the token(s) that destination needs. The new PR's URL is printed to stdout. `pr-backtest status` shows what is saved:

```
$ pr-backtest status
Source token:        saved · authenticates as @octocat · fine-grained
Destination token:   saved · authenticates as @octocat · classic
Default destination: acme/backtests
```

Each line reads `not set` when its slot is empty. Run `pr-backtest logout` to remove the saved tokens (this also deletes the saved default destination — see [Destination](#destination)).

Running against a **Primary** destination (the PR's own repo) prints a plan like this:

```
$ pr-backtest https://github.com/acme/api/pull/123 --primary

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem
Head:    a1b2c3d (PR head — 7 commits)
Base:    f0e9d8c (merge-base with main)

Plan:
  1. Clone acme/api into a temp directory
  2. Fetch commits a1b2c3d and f0e9d8c from origin
  3. Push f0e9d8c → acme/api:backtest-pr123-a1b2c3d-base
  4. Push a1b2c3d → acme/api:backtest-pr123-a1b2c3d-head
  5. Open PR in acme/api: backtest-pr123-a1b2c3d-head → backtest-pr123-a1b2c3d-base

Continue? [y/N] y

https://github.com/acme/api/pull/451
```

A **Sandbox** destination reads the PR from its own repo but writes everything to the repo you choose. The source is tagged `(read-only)` and the write target is named on an `Into:` line:

```
$ pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem   (read-only — source is never written)
Head:    a1b2c3d (PR head — 7 commits)
Base:    f0e9d8c (merge-base with main)
Into:    myuser/pr-backtest-sandbox (sandbox — branches and PR are created here)

Plan:
  1. Clone myuser/pr-backtest-sandbox into a temp directory
  2. Fetch commits a1b2c3d and f0e9d8c from source (acme/api)
  3. Push f0e9d8c → myuser/pr-backtest-sandbox:backtest-pr123-a1b2c3d-base
  4. Push a1b2c3d → myuser/pr-backtest-sandbox:backtest-pr123-a1b2c3d-head
  5. Open PR in myuser/pr-backtest-sandbox: backtest-pr123-a1b2c3d-head → backtest-pr123-a1b2c3d-base

Continue? [y/N] y

https://github.com/myuser/pr-backtest-sandbox/pull/12
```

## Destination

pr-backtest always **reads** the PR from its own repo (the source). The branches and the simulated PR are **written** to a *destination* you choose up front. There are two kinds:

- **Primary** — the PR's own repo. The source and the destination are the same repo, so the backtest lands right next to the original PR.
- **Sandbox** — a separate repo you control. The source repo is read but never written; all writes land in the sandbox. A sandbox keeps a repo you care about completely untouched, and lets you point a review bot at a throwaway repo.

**Read-only guarantee:** the repository a PR is read from is **never written to** unless you explicitly choose it as the destination (Primary). A sandbox destination only ever reads the source.

When you run without a destination flag in a terminal, pr-backtest first offers your existing GitHub login and then asks where the simulated PR should go — see [Guided setup](#guided-setup-auth-first) for the full auth-first flow. A non-default Sandbox choice offers to remember it as your default. Non-interactively (or with a flag) it resolves without prompting. The tool never classifies the destination owner (no org-vs-personal branching).

### Flags

| Flag | Meaning |
|---|---|
| `--primary` | Land the simulated PR in the PR's own repo (no prompt). |
| `--sandbox <owner/repo>` | Land the simulated PR in this repo (no prompt). |
| `--create-sandbox` | With `--sandbox`, create the repo (private) if it is missing. No effect without `--sandbox`. |

`--primary` and `--sandbox` are mutually exclusive. `--create-sandbox` on its own is a no-op.

`pr-backtest logout` deletes the whole config file — including any saved default sandbox destination, not just the token.

## Branch names and re-runs

Each backtest pushes two branches whose names include the **short SHA of the head commit** (the PR head, or the `--commit` cutoff):

```
backtest-pr<N>-<shortSha>-head
backtest-pr<N>-<shortSha>-base
```

So the **(PR, head)** pair is the backtest's identity: the same PR replayed at two different cutoffs produces distinct branches (no collision), while re-running the same PR at the same head targets the same branches.

Before pushing, pr-backtest checks for an existing **open** backtest PR for those branches. If one exists, it exits `4` and prints that PR's URL to stdout:

```
A backtest for acme/api#123 at commit a1b2c3d already exists: https://github.com/acme/api/pull/451
To recreate it, close that PR and re-run (the branch names include the commit SHA).
```

To recreate the backtest, **close that PR and re-run** — a *closed* prior backtest PR no longer blocks, so the re-run opens a fresh one (the re-push to the SHA-named branches is a no-op).

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
✓ Pushing f0e9d8c → backtest-pr123-a1b2c3d-base
✓ Pushing a1b2c3d → backtest-pr123-a1b2c3d-head
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
$ git push origin f0e9d8c:refs/heads/backtest-pr123-a1b2c3d-base  640ms
$ git push origin a1b2c3d:refs/heads/backtest-pr123-a1b2c3d-head  635ms
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

**A Sandbox destination needs read on the source and write on the destination.** A backtest needs two capabilities — **read** the source (to read the PR and fetch its commits) and **write** the destination (Contents + Pull requests). For a **Primary** destination those are the same repo, so one token with read + write on the source is all you need. For a **Sandbox** destination they may be the same token or two different tokens; pr-backtest detects which you gave instead of predicting it.

**One token or two — detected, not predicted.** If a single token can both read the source and write the destination, pr-backtest uses it and never asks for a second. It detects this with the write-permission check it already runs (`repos.get(dest).permissions.push`). When you instead supply two tokens, the split is the trust boundary:

- a **read-only** source token — reads the PR and fetches its commits, and needs **no write access anywhere**, and
- a **write** destination token — Contents + Pull requests on the destination (plus repo-creation rights for `--create-sandbox`).

The source is *only ever read* with the source token, and the write token *only ever writes* the destination. When the run uses two distinct tokens, the confirmation plan notes it: the source line is tagged `(read-only token)` and the `Into:` line `(write token)`. A one-token run renders with no token tags.

To run a `--sandbox <owner/repo>` non-interactively with a quarantined source token, set **`GITHUB_SOURCE_TOKEN`** to the read-only source token; `GITHUB_TOKEN` is then used to write the destination. If `GITHUB_TOKEN` alone can both read the source and write the destination, that one token suffices and `GITHUB_SOURCE_TOKEN` is unnecessary. In a terminal, pr-backtest instead prompts for any missing token in-flow with the exact scope it needs.

**The read-only source token is defense in depth.** Scoping the source token read-only makes a write to the source *impossible by scope*, beyond the code's read-only-source invariant — useful when testing a private company PR in a sandbox you control. A sandbox under your **personal account** is the lowest-fuss path (you can always create repos there) but lands the source's code under your account — an egress consideration to weigh; a sandbox **inside the org** keeps the code within the org boundary but needs org repo-creation rights. Pick whichever matches your compliance posture.

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

- **Deleted or unreachable commits.** If the head or merge-base commit can no longer be fetched — the commit was deleted (an old force-push, a repo transfer/delete), the PR came from a fork whose owner deleted their branch, or your token can't read the commit — the run fails (exit `3`) with the two manual `git push` lines you can use to recreate the branches yourself.
- **No diff across the PR.** If the head and the merge-base produce no difference, GitHub rejects the empty PR (422) and the tool exits `2` rather than opening a no-op PR.
- **PRs with more than 250 commits.** The GitHub API lists only the first 250 commits of a PR. The default (full PR) is unaffected — the head comes from the PR itself, not the commit list — but a `--commit <sha>` cutoff pointing at a commit in the unlisted tail is reported as not matching any commit in the PR; push that commit as a branch manually instead.

## License

MIT
