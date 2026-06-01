/**
 * Tiny stderr logger.
 *
 * All progress/info/success/warn/error output goes to stderr so that stdout
 * stays reserved for the final PR URL (pipe-friendly). Never log secrets here.
 */
import chalk from "chalk";

function write(line: string): void {
  process.stderr.write(line + "\n");
}

/** Neutral informational message. */
export function info(message: string): void {
  write(message);
}

/** A numbered or arrow-prefixed progress step. */
export function step(message: string): void {
  write(chalk.cyan("→ ") + message);
}

/** A successful outcome. */
export function success(message: string): void {
  write(chalk.green("✓ ") + message);
}

/** A non-fatal warning. */
export function warn(message: string): void {
  write(chalk.yellow("! ") + message);
}

/** A failure message. */
export function error(message: string): void {
  write(chalk.red("✗ ") + message);
}
