# pr-backtest — Project Rules

This file establishes the rules and context for any Claude Code session working on this project. Read it at the start of every session.

## What this project is

`pr-backtest` is a standalone open-source CLI tool that recreates a GitHub PR at a chosen commit so PR-review bots (e.g., Macroscope) can review the code as it existed at that moment. The full specification is in `SPEC.md`. Read it first.

This project is **not** a fork or subset of any other project. It is a clean, standalone npm package with its own license (MIT), its own dependencies, and its own git history.

## Reference material

A directory called `reference/` contains source files from an internal project that solves a similar problem. The current contents:

- `reference/create-pr-route.ts` — the original PR simulator implementation from `macroscope-code-review`. Use as a reference for git operations, GitHub API calls, and edge-case handling.

### Rules for using `reference/`

1. **Read for guidance, do not copy verbatim.** The original code is ~1600 LOC, embedded in a Next.js API route, and tangled with SSE streaming, database calls, auth, and proprietary config. The output here is a ~570 LOC standalone CLI. Simplification is required — copying blocks unchanged will pull in dependencies and patterns that don't belong.

2. **Never import from `reference/`.** It is gitignored. Imports would break for anyone who clones this repo from GitHub.

3. **Specific blocks worth studying** (search the file):
   - `parsePrUrl` function — PR URL parsing
   - `getShortHash` function — SHA truncation for display
   - The block starting with `strategyName = "pr-head-fetch"` — the core fetch-by-SHA logic this tool needs
   - `cleanup` function — temp directory removal

4. **Blocks to ignore** (out of scope — see SPEC.md §5 and §5.5):
   - `ensureReferenceRepo` and `acquireRepoLock` — repo caching and concurrency locks
   - `stripGitHubReferences` and any rebase-with-exec logic — cross-reference stripping
   - The cherry-pick fallback block — see SPEC.md §5 for why this is excluded
   - All database calls (`saveFork`, `savePR`, `getFork`, `isRepoCached`, `addCachedRepo`)
   - All auth references (`getAuthSession`)
   - All config references (`config.githubToken`, `GITHUB_ORG`, etc.) — replace with the auth flow described in SPEC.md §3

5. **The `reference/` directory will be deleted** after v0 is complete. Treat it as scaffolding.

## Dependency policy

- Node.js 18+, TypeScript.
- Allowed dependencies: `commander`, `@octokit/rest`, `simple-git`, `prompts`, `chalk`. See SPEC.md §6 for rationale.
- Do not add any other runtime dependencies without explicit user approval. Especially: no telemetry libraries, no analytics SDKs, no error-reporting services. The privacy guarantees in SPEC.md §5.5 depend on the dependency list being short and auditable.
- Dev dependencies (TypeScript, test runner, etc.) are fine but keep them minimal.

## Architectural rules

- Single binary, single entry point (`bin/pr-backtest` → `dist/cli.js`).
- No webapp, no server, no persistent state beyond the config file at `~/.config/pr-backtest/config.json`.
- All network calls go through the Octokit instance or `simple-git` — no direct `fetch`/`https` calls to other hosts.
- Temp directories are always cleaned up via `finally` blocks and a `process.on('exit')` handler. A failed run must not leak `/tmp/pr-backtest-*` directories.

## What "done" looks like

See SPEC.md §11 for the formal definition of done. Summary: working CLI, README covering install/setup/usage/safety/privacy/limitations, unit tests for `parseUrl` and `resolveCommit`, one integration test against a public fixture PR, MIT license, ready to push to GitHub.

## When in doubt

- Reread SPEC.md.
- Prefer simpler over more general. This tool does one thing.
- Prefer fewer dependencies over more.
- Prefer clear error messages over silent fallbacks.
