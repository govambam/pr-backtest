# Changelog

All notable changes to `pr-backtest` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Backtests now recreate the **entire** PR by default — every commit from the
  PR's merge-base up to its head — so a review bot sees the same change set the
  original PR presented. Previously only the PR's first commit was recreated, so
  multi-commit PRs were reviewed as a single commit.
- `--commit <sha>` now recreates the PR **up to** that commit (all commits up to
  it, with the base held at the PR's merge-base), so you can replay the PR as it
  stood before later fix-ups. This replaces the old single-commit selection and
  the `--commit initial` default; omit `--commit` for the full PR.

## [0.2.1] - 2026-06-01

### Changed
- The existing-PR pre-flight now also detects closed and merged prior backtest
  PRs, catching a duplicate before any clone or push and exiting `4` with the
  existing PR's URL.

### Security
- Hardened token redaction: the secret scrubber is now armed before the first
  authenticated request, and the top-level error handler passes through the
  same redaction net as every other output path (defense-in-depth; no known
  leak path existed).

### Fixed
- Corrected the README plan and live-activity-trace examples to match the
  tool's real output, and documented `gh`-login reuse, the exit-code contract,
  and limitations.

## [0.2.0] - 2026-06-01

### Added
- Live activity trace: every operation now shows a friendly `✓` completion
  marker as it finishes (on a terminal, a slow clone/fetch/push shows an
  in-progress line that is replaced in place by its completion line). All trace
  output is on stderr; stdout stays exactly the final PR URL.
- `--verbose`: also print one dim line per **GitHub API request** (method,
  path+query, status, elapsed) and per **git command** (the real argv, elapsed),
  in real time. Off by default; no short alias (`-v` is `--version`).
- Sandbox destinations: choose where the backtest branches and PR are created.
  - `--primary`: land them in the PR's own repo (no prompt).
  - `--sandbox <owner/repo>`: land them in a separate repo you control. The PR is
    still **read** from its original repo; only the writes are redirected to the
    sandbox, and the original repo is never written to. Commits are fetched from
    a `source` remote pointing at the original repo. A token scoped to only the
    sandbox suffices when the original repo is public; a private original
    additionally needs read there.
  - `--create-sandbox`: with `--sandbox`, create the destination repo (always
    **private**) if it does not already exist. No effect without `--sandbox`.
  - Interactively (a TTY with neither flag), pr-backtest prompts for the
    destination and can remember it as the default. `--primary` and `--sandbox`
    are mutually exclusive.

### Security
- Every GitHub API request is traced through a single hook that asserts the host
  is `api.github.com` — any other host is a hard error, enforcing the
  "only GitHub" guarantee at runtime.
- The displayed git commands are the real ones and carry no token: the token is
  supplied via `GIT_ASKPASS`, never in the URL or argv, so the clone URL shows
  only the non-secret `x-access-token@` username. Every trace line (API or git,
  default or verbose) is passed through the redaction filter as a final net.

## [0.1.0] - 2026-05-15

Initial release.

### Added
- `pr-backtest <pr-url>` recreates a GitHub PR at a chosen commit by pushing two
  isolated `backtest-pr<N>-base` / `-head` branches and opening a fresh PR whose
  diff equals the target commit's diff. `main` is never touched.
- `--commit <ref>` selects the target commit (`initial`, the default, or a
  full/abbreviated SHA); the base is the target's first parent.
- `-y, --yes` skips the plan-and-confirm prompt for scripting.
- `-v, --version` prints the version.
- `pr-backtest logout` deletes the saved token.
- Token resolution order: `GITHUB_TOKEN` env → config file
  (`~/.config/pr-backtest/config.json`, mode `0600`) → `gh auth token` (after a
  prompt) → interactive masked paste. Tokens are validated via
  `users.getAuthenticated`.
- Plan-and-confirm by default; the created PR URL is printed to stdout
  (pipe-friendly) while all progress goes to stderr.
- Exit codes: `0` success/declined, `1` bad args, `2` API error, `3` git
  failure, `4` an existing backtest PR (prints its URL).

### Security
- The GitHub token is never logged, never written to the temp clone's
  `.git/config`, and never placed on the git command line. Credentials are
  supplied to git via `GIT_ASKPASS` reading the child process environment.
- The temp clone directory is always removed — on success, on failure, on
  process exit, and on SIGINT/SIGTERM.
- No telemetry, no analytics, no third-party calls. The only outbound hosts are
  `api.github.com` and `github.com`.
