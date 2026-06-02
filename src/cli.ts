/**
 * Commander entrypoint and subcommand routing.
 *
 * Thin layer: parse argv, then hand off to `runBacktest` (the main command) or
 * `deleteConfig` (the `logout` subcommand). All exit-code logic lives in
 * `index.ts` — this file only wires commander to it.
 */
import { readFileSync } from "node:fs";

import { Command } from "commander";

import { deleteConfig } from "./config.js";
import { runBacktest } from "./index.js";
import { redact, success } from "./log.js";
import { runStatus } from "./status.js";

/** Read the package version from package.json (single source of truth). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("pr-backtest")
  .description(
    "Recreate a GitHub PR at a chosen commit so a PR-review bot can review it.",
  )
  .version(packageVersion(), "-v, --version", "Print the version and exit");

program
  .argument("<pr-url>", "Full GitHub PR URL, e.g. https://github.com/acme/api/pull/123")
  .option(
    "--commit <ref>",
    "'initial' (first non-merge commit) or a commit SHA",
    "initial",
  )
  .option("-y, --yes", "Skip the confirmation prompt (for scripting)", false)
  .option("--primary", "Land the backtest in the PR's own repo (no prompt)")
  .option(
    "--sandbox <owner/repo>",
    "Land the backtest branches and PR in this repo (no prompt)",
  )
  .option(
    "--create-sandbox",
    "With --sandbox, create the repo if it does not exist (no effect without --sandbox)",
  )
  .option(
    "--verbose",
    "Show the live activity trace: every GitHub API request and every git command, as they run",
    false,
  )
  .addHelpText(
    "after",
    [
      "",
      "Auth first: in a terminal the tool first offers your existing GitHub login",
      "(\"Use your existing GitHub login? [Y/n]\"), then asks where the backtest PR",
      "lands — the Original repo, or a Sandbox (a separate repo). With the inherited",
      "login it can auto-create the sandbox; otherwise you land in the source with one",
      "token, or pre-create a sandbox and supply two. The source is only ever read for",
      "a Sandbox. With a flag or no TTY it resolves without prompting (see below).",
      "",
      "Environment variables:",
      "  GITHUB_TOKEN         The destination/write token. Also reads the source when it",
      "                       covers it (single-PAT); for --primary it is the one",
      "                       read+write token.",
      "  GITHUB_SOURCE_TOKEN  Optional read-only source token. When set, it reads the",
      "                       source and GITHUB_TOKEN only writes the destination.",
      "",
      "Commands:",
      "  pr-backtest status   Print the saved source/destination token logins + types and",
      "                       the default destination (never a token value). No network.",
      "  pr-backtest logout   Delete the saved config (tokens + default destination).",
      "",
      "Branch naming: branches are backtest-pr<N>-<shortSha>-{head,base}. An existing",
      "OPEN backtest PR for those branches exits 4 and prints its URL; to recreate,",
      "close that PR and re-run (a closed prior PR no longer blocks).",
      "",
      "Examples:",
      "  Land in the PR's own repo:",
      "    pr-backtest https://github.com/acme/api/pull/123 --primary",
      "",
      "  Land in a separate repo you control (creating it if missing):",
      "    pr-backtest https://github.com/acme/api/pull/123 --sandbox myuser/pr-backtest-sandbox --create-sandbox",
      "  To keep the source read with a read-only token, set GITHUB_SOURCE_TOKEN",
      "  (read-only) and GITHUB_TOKEN (write).",
    ].join("\n"),
  )
  .action(
    async (
      prUrl: string,
      options: {
        commit: string;
        yes: boolean;
        primary?: boolean;
        sandbox?: string;
        createSandbox?: boolean;
        verbose?: boolean;
      },
    ) => {
      await runBacktest({
        prUrl,
        commit: options.commit,
        yes: options.yes,
        primary: options.primary,
        sandbox: options.sandbox,
        createSandbox: options.createSandbox,
        verbose: options.verbose,
      });
    },
  );

program
  .command("status")
  .description(
    "Print what is saved (token logins + types and the default destination). Reads only stored metadata — no network call, no token value.",
  )
  .action(() => {
    runStatus();
    process.exit(0);
  });

program
  .command("logout")
  .description(
    "Delete the saved config (GitHub token and any saved default destination).",
  )
  .action(() => {
    deleteConfig();
    success(
      "Logged out: saved token and any saved default destination removed.",
    );
    process.exit(0);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // runBacktest owns all expected exit codes via process.exit; reaching here
  // means an unexpected throw. Fail with a generic code-1 error. The message
  // goes through redact() so a registered token can never escape via an
  // unexpected error, the same net every other output path uses.
  process.stderr.write(
    redact(err instanceof Error ? err.message : String(err)) + "\n",
  );
  process.exit(1);
});
