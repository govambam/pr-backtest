# pr-backtest

Recreate a GitHub pull request — all of its commits — so a PR-review bot can review the code exactly as the PR presented it. Point it at a PR URL and it opens a fresh PR whose diff matches the original's, from the PR's merge-base up to its head. Your `main` branch is never touched.

**Why:** backtest a PR-review bot against history. Take a PR whose outcome you already know, replay it at its original commit, and see how your bot does on a "brand new" PR.

> **Just want a quick one-off?** If you only need to recreate a PR as a temporary PR in **its own repo**, and you already use `git` + the [`gh` CLI](https://cli.github.com), you don't need to install anything — a single shell script does it: **[pr-backtest-script](https://github.com/govambam/pr-backtest-script)**.
>
> Use this full CLI when you need to backtest a repo you don't own without writing to it (a separate **sandbox** repo, source read-only), or to replay a PR **as it was originally opened** rather than the full PR.

**Security:** pr-backtest only ever talks to GitHub — `api.github.com` and `github.com`, nothing else. No telemetry, no analytics, no third-party calls. Your token stays on your machine (read from `GITHUB_TOKEN` / `GITHUB_SOURCE_TOKEN`, or saved locally with `0600` permissions) and is never sent anywhere except GitHub. See [Security](#security) for the data flow and where each guarantee is enforced.

## Requirements

Node.js `>=18` and a `git` binary on your `PATH` (the tool shells out to `git` for clone/fetch/push).

## Quickstart

Recreate your first PR end to end and have a review bot review the result.

pr-backtest reads a PR from its **source** repo and writes a fresh "backtest" PR into a **destination** repo, where the review bot (Macroscope) reviews it. You make two decisions: *how to authenticate* and *which repo is the destination*.

### 1. Install the CLI

```bash
git clone https://github.com/govambam/pr-backtest.git
cd pr-backtest
npm install        # install dependencies
npm install -g .   # build and install the `pr-backtest` command globally
```

Check it: `pr-backtest --version`. To update later, run `npm run update` from this folder — it always installs the latest `main` and prints the commit it installed.

### 2. Pick your path

| Path | Use it when | Trade-off |
|---|---|---|
| **A — Your GitHub login** | You just want to try it on your own machine | Easiest, nothing to create; acts with your full GitHub permissions; needs an interactive terminal |
| **B — Scoped tokens → sandbox repo** | Backtesting a PR you don't own (a company repo) without touching it | The source repo is only ever read; you create a temporary repo and (optionally) use two tokens |
| **B — Scoped tokens → source repo** | The PR is in a repo you own and don't mind writing to | One token, the backtest sits next to the original PR — but it writes branches + a PR into the real repo |

The **destination** is the sandbox in the sandbox paths, and the PR's own repo in the source path.

### 3. Connect Macroscope to your destination repo

Add the Macroscope GitHub app before you run the backtest so the correctness check fires automatically when the PR opens.

> **Already have correctness checks on by default for all repos?** Then there's nothing to do here — the backtest PR in your new sandbox gets reviewed automatically. Skip to the next step.

1. If you haven't already, install the Macroscope GitHub app and give it access to your destination repo.
2. Enable **correctness checks** on that repo in your Macroscope settings: `https://app.macroscope.com/<your-org>/settings#Repos` (for example `https://app.macroscope.com/govambam/settings#Repos`).

**Order matters for a sandbox** (only if you enable correctness per-repo rather than by default): the repo must exist before Macroscope can see it. So **create the sandbox first → enable correctness on it → then run pr-backtest.** If you let pr-backtest auto-create the sandbox (Path A), the repo won't exist until after the run; enable correctness on the new repo afterward and trigger the review by hand.

**To trigger a review at any time**, comment on the backtest PR:

```
@macroscope-app review
```

### 4. Run it

#### Path A — your existing GitHub login (easiest)

pr-backtest uses the GitHub credential your terminal already has (via `git` / the `gh` CLI) — no tokens to create. It needs an interactive terminal and acts with your account's full permissions. To create a sandbox inside an org, your account must be allowed to create repos there.

```bash
pr-backtest https://github.com/OWNER/REPO/pull/NUMBER
```

Then:

1. **Use your existing GitHub login? [Y/n]** → `y`.
2. **Where should the backtest PR land?**
   - **A new sandbox repo** — pr-backtest creates a private `OWNER/REPO-backtest` (you can rename it) and only ever *reads* the source. To have Macroscope review it automatically, pre-create that repo and connect Macroscope first (step 3), then type its name here — pr-backtest reuses an existing repo it can write to. Otherwise let it create the repo and trigger the review with a comment afterward.
   - **Original repo** — the branches and backtest PR go into the PR's own repo.

   The sandbox you pick is **remembered for this source repo**, so the next backtest of it reuses the sandbox automatically (no re-picking) — and if you've backtested this repo before, your saved sandbox is offered first. Run `pr-backtest status` to see what's saved.
3. Confirm the printed plan (it shows `Head:` / `Base:` and the commit count).
4. pr-backtest prints the new PR's URL.

#### Path B — scoped tokens

You pass tokens explicitly via environment variables. No inherited login, works non-interactively (CI), and lets you grant the least privilege needed. Create fine-grained tokens at <https://github.com/settings/personal-access-tokens/new>.

**Sandbox repo (recommended for PRs you don't own).** A separate private repo you control; the source repo is only ever read.

- **Pros:** the original repo is never written to; review noise is isolated in the sandbox; the source token can be scoped read-only, so writing to the source is impossible by scope.
- **Cons:** you create the sandbox yourself; the backtest PR lives in a different repo than the original.

```bash
# 1. Create a private sandbox repo on GitHub, e.g. you/pr-backtest-sandbox
# 2. Connect Macroscope to it (step 3)
# 3. Create two tokens:
#      SOURCE (read-only): Contents: Read, Pull requests: Read, Metadata: Read   — on the source repo
#      DEST   (read+write): Contents: R/W, Pull requests: R/W, Metadata: Read     — on the sandbox
# 4. Run:
GITHUB_SOURCE_TOKEN=<source-read-token> \
GITHUB_TOKEN=<dest-write-token> \
  pr-backtest https://github.com/OWNER/REPO/pull/NUMBER --sandbox you/pr-backtest-sandbox
```

If a single token can both read the source and write the sandbox, drop `GITHUB_SOURCE_TOKEN` and pass only `GITHUB_TOKEN` — pr-backtest detects that one token covers both. (Add `--create-sandbox` to have pr-backtest create the repo if it's missing; the destination token then also needs repo-creation rights, and you'll connect Macroscope after the run.)

**Original (source) repo.** The branches and backtest PR land in the PR's own repo. This is `--primary`.

- **Pros:** simplest — one token, no extra repo, and the backtest sits right next to the original PR.
- **Cons:** it writes to the real repo (a new branch pair and a PR), which can notify teammates and trigger CI. Use only on a repo you own and don't mind writing to.

```bash
# 1. Connect Macroscope to the source repo (step 3)
# 2. Create one token with Contents: R/W + Pull requests: R/W + Metadata: Read on the repo
# 3. Run:
GITHUB_TOKEN=<token> pr-backtest https://github.com/OWNER/REPO/pull/NUMBER --primary
```

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
npm run update     # switch to main, pull, install deps, rebuild, reinstall globally
```

`npm run update` always installs the latest `main` — it checks out `main` first,
so it works no matter which branch you're currently on — and prints the branch
and commit it installed so you can confirm.

To rebuild and reinstall from whatever you have checked out **right now** (e.g.
to test a feature branch before it merges), use:

```bash
npm run reinstall  # rebuild dist/ and reinstall globally from the current branch
```

## Setup

There is no separate setup step — pr-backtest resolves credentials inside the run. This section is the reference for how: the interactive prompts, the two environment variables, and where tokens are saved. For a first run, follow the [Quickstart](#quickstart) instead.

A backtest needs two capabilities — **read** the source and **write** the destination. One token may provide both, or you may split them across two; the tool detects which you gave.

### Guided setup (auth-first)

In an interactive terminal pr-backtest walks an **auth-first** flow before any plan:

1. **Inherited login offer.** It looks for a GitHub credential the terminal already has (via `git credential` and the `gh` CLI). If it finds one, it offers it by name — *"Use your existing GitHub login? [Y/n]"* (defaults to yes). No token is ever printed; only the `@login` is named.

2. **If you accept the login (YES):** it asks *"Where should the backtest PR land?"*:
   - **Your saved sandbox** *(shown only if you've backtested this source repo before)* — reuse the sandbox you used last time for this source, no re-entry.
   - **Original repo** — write the backtest branches and PR straight into the PR's own repo.
   - **A new sandbox repo** — the tool **auto-creates** a private repo `<owner>/<repo>-backtest` (you can edit the name) to hold the backtests, reading the source read-only. If your login can't create repos in that owner, it offers to land in the original repo instead.

   Whatever sandbox you land in is **remembered for that source repo** (on a successful run) and offered/reused on the next backtest of the same source — regardless of which auth method you use. See [Destination](#destination).

3. **If you decline, or no login is detected (NO / scoped):** if you have a saved sandbox for this source repo it is offered first (reuse it); otherwise it asks *"Land the backtest PR in the original source repo? [Y/n]"*:
   - **Yes** → Primary: branches and PR go in the source repo using one read + write token.
   - **No** → you **pre-create** a private sandbox repo yourself, enter it when prompted, then paste two tokens: a read-only **source** token first, then a read + write **destination** token. The source is only ever read.

Non-interactive runs and runs with a destination flag skip the prompts entirely and resolve from env vars / saved config / flags (see below).

**Two environment variables (owner-agnostic):**

- **`GITHUB_TOKEN`** — the destination/write token. It also reads the source when it covers the source too (the single-PAT case). For a **Primary** destination it is the one read + write token. Set it with `export GITHUB_TOKEN=github_pat_...` (or prefix a single run: `GITHUB_TOKEN=github_pat_... pr-backtest <pr-url>`). Non-interactive runs require it.
- **`GITHUB_SOURCE_TOKEN`** — optional read-only source token. When set, it reads the source and `GITHUB_TOKEN` only writes the destination. This is the quarantined two-token setup (the source token can be scoped read-only, so a write to the source is impossible by scope).

Per-capability resolution order (first match that validates wins):

- **Write/destination token:** `GITHUB_TOKEN` env → saved `destinationTokens[<dest-owner>/<dest-repo>]` → interactive paste.
- **Read/source token:** `GITHUB_SOURCE_TOKEN` env → saved `sourceTokens[<src-owner>]` → the resolved write token *iff* it can read the source → interactive paste.

A pasted token is saved automatically to `~/.config/pr-backtest/config.json` (mode `0600`), keyed per destination repo / source owner, so a later run resolves it without prompting. In a terminal, a missing token is prompted for in-flow with the exact scope it needs; non-interactively, a missing token exits `1` naming the relevant env var. Otherwise, create a fine-grained token with the permissions in [Recommendations](#recommendations). Run `pr-backtest status` to see what is saved, and `pr-backtest logout` to clear it (tokens and any saved per-repo sandboxes).

## Usage

```bash
# Recreate the PR AS IT WAS OPENED (the default) — only the commits that existed
# when the PR was opened, excluding anything pushed afterward. Prints a plan,
# asks to confirm.
pr-backtest https://github.com/acme/api/pull/123

# Recreate the WHOLE PR — every commit, including any added after it was opened.
pr-backtest https://github.com/acme/api/pull/123 --full

# Recreate the PR only up to a commit (all commits up to it; base stays the merge-base).
# Useful to replay the PR as it stood before later fix-up commits.
# (Cannot be combined with --full.)
pr-backtest https://github.com/acme/api/pull/123 --commit a1b2c3d

# Skip the confirmation prompt (for scripting)
pr-backtest https://github.com/acme/api/pull/123 -y

# Land the backtest in the PR's own repo, no prompt
pr-backtest https://github.com/acme/api/pull/123 --primary

# Land the backtest in a separate sandbox repo you control
pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox

# Create that sandbox first if it doesn't exist yet (private)
pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox --create-sandbox

# Remove the saved tokens and per-repo sandboxes
pr-backtest logout
```

### Commit scope

By default the backtest recreates the PR **as it was opened**: the commits whose
committer date is at or before the PR's `created_at`. If commits were pushed
after the PR opened, the default leaves them out (so the review sees the original
change set). If nothing was added after open — the common case — the as-opened
set is the whole PR.

| Flag | Meaning |
|---|---|
| _(none)_ | Recreate the PR **as opened** (commits committed at/before `created_at`). |
| `--full` | Recreate the **whole PR** — every commit, including any added after open. |
| `--commit <sha>` | Recreate every commit up to `<sha>` (head = `<sha>`; base stays the merge-base). |

`--full` and `--commit` are mutually exclusive (supplying both exits 1). If the
branch was rebased/force-pushed after the PR opened — so every commit's date is
after `created_at` and the as-opened state can't be recovered — the default falls
back to `--full` and prints a one-line note suggesting `--commit <sha>` to pin a
cutoff.

### Commands

| Command | Description |
|---|---|
| `pr-backtest <pr-url> [options]` | Recreate the PR as it was opened (default; `--full` for every commit) and open a backtest PR. |
| `pr-backtest status` | Print the saved per-repo sandboxes and the source/destination token logins + types. Never prints a token value; makes no network call. |
| `pr-backtest logout` | Delete the saved config (all token slots and any saved per-repo sandboxes). |

`pr-backtest status` shows what's saved:

```
$ pr-backtest status
Saved sandboxes:
  acme/api → octocat/api-backtest
Source tokens:
  acme → @octocat · fine-grained
Destination tokens:
  octocat/api-backtest → @octocat · classic
```

Before any writes, pr-backtest prints the plan and asks to confirm. A Sandbox run reads the PR from its own repo, writes everything to your chosen repo, and tags the source `(read-only)`:

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

When you run without a destination flag in a terminal, pr-backtest first offers your existing GitHub login and then asks where the simulated PR should go — see [Guided setup](#guided-setup-auth-first) for the full auth-first flow. After a successful run, the sandbox you chose is remembered for that source repo and offered (and reused) on the next backtest of the same source. Non-interactively (or with a flag) it resolves without prompting.

### Flags

| Flag | Meaning |
|---|---|
| `--primary` | Land the simulated PR in the PR's own repo (no prompt). |
| `--sandbox <owner/repo>` | Land the simulated PR in this repo (no prompt). |
| `--create-sandbox` | With `--sandbox`, create the repo (private) if it is missing. No effect without `--sandbox`. |

`--primary` and `--sandbox` are mutually exclusive. `--create-sandbox` on its own is a no-op.

`pr-backtest logout` deletes the whole config file — including the per-repo saved sandboxes, not just the tokens.

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

pr-backtest prints each step as it runs — a `✓` line for auth, read PR, clone, fetch, push, and open PR — so you can watch that it only **reads** the source, only **writes** your chosen destination, and only talks to `api.github.com`. Everything goes to **stderr**; stdout stays exactly the final PR URL, so `pr-backtest … | pbcopy` works. On a terminal, slow steps (clone/fetch/push) show an in-progress line that's overwritten on completion.

Add `--verbose` to also print one line per GitHub API request and per git command, with method/path (or argv) and timing:

```
→ GET  /repos/acme/api/pulls/123  200  142ms
$ git clone --no-checkout https://x-access-token@github.com/octocat/sandbox.git <tmp>/repo  1100ms
$ git push origin a1b2c3d:refs/heads/backtest-pr123-a1b2c3d-head  635ms
→ POST /repos/octocat/sandbox/pulls  201  301ms
```

The `x-access-token@` in those URLs is only a non-secret username — the token reaches git through `GIT_ASKPASS`, never the URL or the argv, so the output is safe to share (see [Security](#security)). Verbose has no short alias (`-v` is `--version`).

## Recommendations

**Use a fine-grained token scoped to just the repo(s) you write to.** Create one at <https://github.com/settings/personal-access-tokens/new> with these permissions:

| Permission    | Access       |
|---------------|--------------|
| Contents      | Read & write |
| Pull requests | Read & write |
| Metadata      | Read         |

A token like this can't reach your other repos or touch org settings. For `--create-sandbox`, the token also needs permission to create repositories for the destination owner.

**A Sandbox destination needs read on the source and write on the destination** — read to fetch the PR and its commits, write (Contents + Pull requests) to push the branches and open the PR. For a **Primary** destination those are the same repo, so one token with read + write on it is all you need.

For a **Sandbox**, one token works if it can both read the source and write the destination; otherwise use two — a read-only `GITHUB_SOURCE_TOKEN` for the source and a write `GITHUB_TOKEN` for the destination (`--create-sandbox` also needs repo-creation rights on the destination owner). When two distinct tokens are used, the confirmation plan tags the source line `(read-only token)` and the `Into:` line `(write token)`. Scoping the source token read-only is defense in depth — see [Security](#security).

## Security

pr-backtest contacts only GitHub — `api.github.com` for the API, `github.com` for git over HTTPS — and persists nothing but an optional `0600` token file. It carries two capabilities: read on the source repo, write on the destination. The data flow, guarantees, and their enforcement points follow.

### Data flow and trust boundary

```
   ┌──────────────────┐                              ┌──────────────────────┐
   │   SOURCE repo    │                              │   DESTINATION repo   │
   │  (never written) │                              │ (sandbox or source)  │
   └────────┬─────────┘                              └───────────▲──────────┘
            │  read: PR + commits   write: branches + open PR     │
            │  (read token)              (write token)            │
            │                                                     │
            │         ┌───────────────────────────────────┐       │
            └────────▶│            pr-backtest            │───────┘
                      │                                   │
                      │  • token → GIT_ASKPASS env        │
                      │    (never in a URL or argv)       │
                      │  • redact() scrubs every line     │
                      │  • only host: api.github.com      │
                      └─────────────────┬─────────────────┘
                                        │
                                        ▼
                            stdout: the new PR's URL only
```

The **trust boundary is the pair of tokens**: a read capability over the source and a write capability over the destination. When one token can do both, pr-backtest uses it and never asks for a second; when you supply two, the source token *only ever reads the source* and the write token *only ever writes the destination*. The split is detected from GitHub's own permission data, not predicted (see [Recommendations](#recommendations)).

### Guarantees — and where each is enforced

| Guarantee | Where it's enforced |
|---|---|
| **The token is never written to any log, stdout, or stderr.** Every line out of the process passes through a redaction net that replaces the registered token with `***`. | `registerSecret()` / `redact()` in `src/log.ts` — `write()` redacts before every `process.stderr.write`. |
| **The token is never embedded in a git remote URL** (which git persists to disk and which leaks via `ps` / `/proc/<pid>/cmdline`). It reaches git only through a `GIT_ASKPASS` helper that reads it from an owner-readable env var. | `authedRemoteUrl()` (URL carries only the `x-access-token` username) and the `GIT_ASKPASS` helper in `src/git.ts`. |
| **The tool only ever contacts `api.github.com`.** Every resolved API request asserts its host; any other host is a hard error, not a silent skip. No telemetry, analytics, or third-party calls exist in the code. | `GITHUB_API_HOST` host check in `src/github.ts` (throws on mismatch). |
| **The read token never performs a write; the write token never touches the source.** Orchestration resolves the destination first (local, no network), then the write token, then the read token — reusing one token only when it can do both. | Orchestration order documented and implemented in `src/index.ts` (`runBacktest`). |
| **Your `main` is never touched.** The backtest is recreated on fresh, named branches from the merge-base to the head; nothing is force-pushed over existing refs. | Branch planning in `src/plan.ts`; push logic in `src/git.ts`. |
| **A saved token lives only on your machine, `0600`.** Tokens read from the environment are never persisted; tokens you opt to save are written owner-only. | Config read/write in `src/config.ts`. |

### Defense in depth

Scoping the **source token read-only** makes a write to the source *impossible by scope* — a second layer beneath the code's read-only-source invariant, useful when backtesting a PR in a repo you don't own. A sandbox under your **personal account** needs no extra rights but lands the source's code under your account (an egress consideration); a sandbox **inside the org** keeps the code within the org boundary but needs org repo-creation rights. See [Recommendations](#recommendations) for the exact token scopes.

## Exit codes

The tool exits with a stable code so it can be wired into CI:

| Code | Meaning |
|---|---|
| `0` | Success, or the user declined the confirmation prompt (no changes made). |
| `1` | Bad args — invalid PR URL, invalid `--commit`, both `--full` and `--commit`, both `--primary` and `--sandbox`, or no token in a non-interactive run. |
| `2` | GitHub API error — PR not found, auth rejected, or the destination is missing / not writable. |
| `3` | A git operation failed (clone / fetch / push). |
| `4` | A backtest PR already exists for the planned branches. The existing PR's URL is printed to stdout — a useful CI signal. |

Because exit `4` prints the existing PR's URL to stdout, a re-run is idempotent: a script can treat exit `0` and exit `4` alike and read the PR URL from stdout in both cases.

## Limitations

- **Deleted or unreachable commits.** If the head or merge-base commit can no longer be fetched — the commit was deleted (an old force-push, a repo transfer/delete), the PR came from a fork whose owner deleted their branch, or your token can't read the commit — the run fails (exit `3`) with the two manual `git push` lines you can use to recreate the branches yourself.
- **No diff across the PR.** If the head and the merge-base produce no difference, GitHub rejects the empty PR (422) and the tool exits `2` rather than opening a no-op PR.
- **As-opened is best-effort (clock skew / rebases).** The default scope buckets commits by comparing each commit's **committer date** to the PR's `created_at`. A commit committed within minutes of opening could be mis-bucketed if the author's clock was skewed. If the branch was rebased/force-pushed after opening, every committer date is rewritten to after `created_at`, so the as-opened state can't be recovered — the tool falls back to `--full` and prints a note. Use `--full` or `--commit <sha>` when you need exact, date-independent control.
- **PRs with more than 250 commits.** The GitHub API lists only the first 250 commits of a PR. `--full` is unaffected — the head comes from the PR itself, not the commit list — but the as-opened default and a `--commit <sha>` cutoff rely on the listed commits; a cutoff pointing at a commit in the unlisted tail is reported as not matching any commit in the PR; push that commit as a branch manually instead.

## License

MIT
