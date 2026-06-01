# pr-backtest

## What this does

`pr-backtest` recreates a GitHub pull request at a chosen commit, so a PR-review bot (e.g. Macroscope, or any bot that auto-runs on new PRs) can review the code exactly as it existed at that moment. Point it at a PR URL; it pushes two isolated `backtest-pr*` branches and opens a fresh PR whose diff equals the target commit's diff. It never touches `main`.

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

Continue? [y/N] y

https://github.com/acme/api/pull/451
```

The created PR's URL is the final line on stdout, so it is pipe-friendly:

```bash
URL=$(pr-backtest https://github.com/acme/api/pull/123 -y)
```

## The problem it solves

Replay an old PR at a chosen commit so your PR-review bot reviews it fresh — as if the code were brand new. This is useful for **backtesting reviewer-bot quality against historical PRs**: take a PR you already know the outcome of, recreate it, and see how your bot does. Because the recreated PR lives on isolated branches in the same repo, any review bot installed on that repo picks it up automatically. No webapp, no database, no comments posted back to the original PR.

## Install

```bash
npm install -g pr-backtest
```

Or run it without installing:

```bash
npx pr-backtest <pr-url>
```

## Setup

`pr-backtest` needs a GitHub token. On first run, if no token is configured, it prompts you interactively (and offers to reuse your `gh` CLI token if you have one).

**Recommended: a fine-grained personal access token** scoped to just the one repository you're backtesting. Create one at:

> https://github.com/settings/personal-access-tokens/new

Grant exactly these permissions for that repo — the minimum needed to function:

| Permission     | Access       | Why                                              |
|----------------|--------------|--------------------------------------------------|
| Contents       | Read & write | Push the two `backtest-pr*` branches             |
| Pull requests  | Read & write | Read the original PR and open the simulated one  |
| Metadata       | Read         | Required for all tokens                           |

A fine-grained token scoped to one repo cannot access your other repos, cannot create repos, and cannot read or modify org settings — so a leaked token has a contained blast radius.

**Classic token alternative.** If you prefer a classic token, create one with the `repo` scope at <https://github.com/settings/tokens/new>. Note the wider blast radius: a classic `repo` token grants access to **all** your private repos. The tool itself still only ever touches the one repo named in the PR URL, but the credential is broader.

**`GITHUB_TOKEN` env var (CI / scripting).** Set `GITHUB_TOKEN` and the tool uses it directly, skipping the config file and any prompt — convenient for CI.

**`gh` CLI reuse.** If [`gh`](https://cli.github.com/) is installed and authenticated, the tool offers to reuse its token (after asking), so there are no new credentials to create or store.

Token resolution order (first match wins): `GITHUB_TOKEN` env var → config file (`~/.config/pr-backtest/config.json`) → `gh auth token` → interactive prompt.

## Usage

```bash
# Default: recreate at the PR's initial (first non-merge) commit, show plan, confirm
pr-backtest https://github.com/acme/api/pull/123

# Recreate at a specific commit (head at that commit, base at its parent)
pr-backtest https://github.com/acme/api/pull/123 --commit a1b2c3d

# Skip the confirmation prompt (scripting)
pr-backtest https://github.com/acme/api/pull/123 -y
```

Run `pr-backtest logout` to delete the saved token from the config file.

## How it works

- **Parse + fetch the PR.** Read `(owner, repo, number)` from the URL, then fetch the PR and its commit list via the GitHub REST API.
- **Resolve the target and base commit.** `--commit` (default `initial`) selects the target commit; the base is the target's first parent.
- **Push two branches by SHA.** Clone the repo into a temp dir, fetch the two commits from origin, and push them as `backtest-pr<N>-base` and `backtest-pr<N>-head` using a `<sha>:refs/heads/<branch>` refspec — no local checkout.
- **Open the PR head → base** via the GitHub API and print its URL.

By default the tool prints a full plan and asks for confirmation before doing anything that changes state (the `-y` flag skips this).

## Safety

- **`main` is never checked out, written to, or pushed to.** The tool only pushes the two `backtest-pr*` branches by SHA.
- **The `backtest-pr*` branches are isolated.** Opening a PR between them merges nothing; they sit alongside your real branches.
- **Plan-and-confirm by default.** Every run prints the SHAs, branch names, and numbered steps and waits for your `y` before any state change.
- **The temp clone is always cleaned up.** Removal runs in a `finally` block and a `process.on('exit')` handler, so a failed run does not leak a `/tmp/pr-backtest-*` directory.

## Privacy

`pr-backtest` is built to be provably narrow for security-conscious teams running it against private code.

- **No telemetry, no analytics, no error reporting, and no calls to any Macroscope server or other third party.** The tool phones nothing home.
- **The only outbound hosts are `api.github.com`** (GitHub REST API — read PR data, open the simulated PR) **and `github.com`** (git clone, fetch, and push over HTTPS). Nothing else.
- **Your token is stored locally** at `~/.config/pr-backtest/config.json` with file mode `0600` (owner read/write only). It is **never logged**, never printed to stdout/stderr, and never written into the temp clone directory.
- **`pr-backtest logout` deletes** the config file.
- **The source is auditable.** The whole tool is roughly 570 lines of plain TypeScript with a short, pinned dependency list (`commander`, `@octokit/rest`, `simple-git`, `prompts`, `chalk`). If you'd rather not trust npm, clone this repo and `npm install` locally.

To revoke a token, use <https://github.com/settings/personal-access-tokens> (fine-grained) or <https://github.com/settings/tokens> (classic).

## Limitations

- **One PR at a time.** No batch mode — one PR per invocation.
- **Requires push access to the repo.** The tool pushes branches into the same repo. If you don't have push access, fork the repo first and point the tool at the fork's PR URL.
- **The target commit (and its parent) must still be fetchable from GitHub.** If a commit was deleted — a very old force-push that GitHub eventually GC'd, or a repo transfer/delete — neither the target nor its parent can be fetched, and the backtest can't be reconstructed. The tool fails fast with a clear error and a manual `git push` fallback.

## Contributing

```bash
git clone https://github.com/<owner>/pr-backtest
cd pr-backtest
npm install
npm run build
npm test
```

The unit tests run with no setup. The integration test in `test/integration.test.ts` is **gated on `GITHUB_TOKEN`** — it is skipped unless that env var is set, so `npm test` stays green without credentials. To run it end-to-end, set `GITHUB_TOKEN` (a token with push access to the fixture repo) and optionally `TEST_FIXTURE_REPO` to point at your own fixture PR.

## License

MIT — see [LICENSE](./LICENSE).
