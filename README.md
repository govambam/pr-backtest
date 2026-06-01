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

# Create the backtest branches + PR in a fork, not the PR's own repo
pr-backtest https://github.com/acme/api/pull/123 --fork myuser/api
```

On first run it prompts for a GitHub token (and offers to reuse your `gh` CLI login if you have one). The new PR's URL is printed to stdout. Run `pr-backtest logout` to remove a saved token.

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

## Recommendations

**Use a fine-grained token scoped to one repo.** Create one at <https://github.com/settings/personal-access-tokens/new> with just these permissions, for just the repo you're backtesting:

| Permission    | Access       |
|---------------|--------------|
| Contents      | Read & write |
| Pull requests | Read & write |
| Metadata      | Read         |

A token like this can't reach your other repos, create repos, or touch org settings.

**For maximum isolation, use a fork.** Fork the repo, then pass `--fork <owner/repo>`:

```bash
pr-backtest https://github.com/acme/api/pull/123 --fork myuser/api
```

pr-backtest reads the PR from the original repo but creates the backtest branches and PR in your fork — the original repo is never written to. If the original repo is **public**, a token scoped to only the fork is enough. If it's **private**, the token also needs read access on the original repo (to read the PR and fetch its commits) — still narrower than granting write access there.

## License

MIT
