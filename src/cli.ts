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
import { success } from "./log.js";

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
  .option(
    "--fork <owner/repo>",
    "Create the backtest branches and PR in this fork instead of the PR's own repo",
  )
  .action(
    async (
      prUrl: string,
      options: { commit: string; yes: boolean; fork?: string },
    ) => {
      await runBacktest({
        prUrl,
        commit: options.commit,
        yes: options.yes,
        fork: options.fork,
      });
    },
  );

program
  .command("logout")
  .description("Delete the saved GitHub token from the config file.")
  .action(() => {
    deleteConfig();
    success("Logged out: saved token removed.");
    process.exit(0);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // runBacktest owns all expected exit codes via process.exit; reaching here
  // means an unexpected throw. Fail with a generic code-1 error.
  process.stderr.write(
    (err instanceof Error ? err.message : String(err)) + "\n",
  );
  process.exit(1);
});
