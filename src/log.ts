/**
 * Tiny stderr logger.
 *
 * All progress/info/success/warn/error output goes to stderr so that stdout
 * stays reserved for the final PR URL (pipe-friendly).
 *
 * Defense-in-depth: callers may {@link registerSecret} the GitHub token (and any
 * derived form, e.g. a base64 credential header). Every line written here — and
 * via {@link redact} for stdout — has registered secrets replaced with `***`
 * before it leaves the process, so a stray git/API error string can never leak
 * the token even if an upstream path forgets to sanitize it.
 */
import chalk from "chalk";

/** Registered secret strings, scrubbed from all output. */
const secrets = new Set<string>();

/**
 * Register a secret to be scrubbed from every subsequent log line (and any
 * string passed through {@link redact}). Short/empty values are ignored so we
 * never blanket-replace trivial substrings.
 */
export function registerSecret(secret: string): void {
  if (secret && secret.length >= 8) {
    secrets.add(secret);
  }
}

/** Replace every registered secret in `text` with `***`. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

function write(line: string): void {
  process.stderr.write(redact(line) + "\n");
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
