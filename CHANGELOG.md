# Changelog

All notable changes to `pr-backtest` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-01

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
