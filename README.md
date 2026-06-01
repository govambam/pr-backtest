# pr-backtest

Recreate a GitHub pull request at a chosen commit, so a PR-review bot can review the code exactly as it existed then. Point it at a PR URL and it opens a fresh PR whose diff matches that commit. Your `main` branch is never touched.

**Why:** backtest a PR-review bot against history. Take a PR whose outcome you already know, replay it at its original commit, and see how your bot does on a "brand new" PR.

**Security:** pr-backtest only ever talks to GitHub — `api.github.com` and `github.com`, nothing else. No telemetry, no analytics, no third-party calls. Your token stays on your machine (read from `GITHUB_TOKEN` / `gh`, or saved locally with `0600` permissions) and is never sent anywhere except GitHub.

## Install

```bash
npm install -g pr-backtest
# or run it without installing:
npx pr-backtest <pr-url>
```

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
```

On first run it prompts for a GitHub token (and offers to reuse your `gh` CLI login if you have one). The new PR's URL is printed to stdout. Run `pr-backtest logout` to remove a saved token (this also deletes the saved default destination — see [Destination](#destination)).

```
$ pr-backtest https://github.com/acme/api/pull/123

PR:      acme/api#123 "Add retry logic to webhook handler" by @stevem
Target:  a1b2c3d (initial commit)
Base:    f0e9d8c (parent of target)

Plan:
  1. Clone acme/api into a temp directory
  2. Fetch commits a1b2c3d and f0e9d8c from origin
  3. Push f0e9d8c → backtest-pr123-base
  4. Push a1b2c3d → backtest-pr123-head
  5. Open PR: backtest-pr123-head → backtest-pr123-base

Continue? [y/N] y

https://github.com/acme/api/pull/451
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

**Default view.** Each operation prints a friendly `✓` completion marker as it finishes:

```
✓ Authenticated as @octocat
✓ Read PR acme/api#123  "Add retry to fetch"
✓ Verified destination octocat/pr-backtest-sandbox  github.com/octocat/pr-backtest-sandbox
✓ Cloning github.com/octocat/pr-backtest-sandbox
✓ Fetching 9f3c1a2 from source
✓ Pushing 9f3c1a2 → backtest-pr123-base
✓ Pushing a1b2c3d → backtest-pr123-head
✓ Opened backtest PR
```

On a terminal, a slow step (clone/fetch/push) first shows an in-progress line that is replaced in place by its completion line; piped to a file, only the completion line is written. All of this goes to **stderr** — stdout stays exactly the final PR URL, so `pr-backtest … | pbcopy` still works.

**`--verbose`.** Add `--verbose` to also see, in real time, one dim line per **GitHub API request** and per **git command**, each with method/path (or argv) and an elapsed time:

```bash
pr-backtest https://github.com/acme/api/pull/123 --verbose
```

```
  → GET   /repos/acme/api/pulls/123                          200  142ms
  $ git clone --no-checkout https://x-access-token@github.com/octocat/pr-backtest-sandbox.git <tmp>/repo   1.1s
  $ git fetch source 9f3c1a2                                 312ms
  $ git push origin 9f3c1a2:refs/heads/backtest-pr123-base   640ms
  → POST  /repos/octocat/pr-backtest-sandbox/pulls           201  301ms
```

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

## License

MIT
