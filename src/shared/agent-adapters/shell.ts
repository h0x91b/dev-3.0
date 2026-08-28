/**
 * Low-level shell-quoting helpers shared by every agent adapter.
 *
 * Pure string utilities (no I/O). Moved from src/bun/agents.ts so the adapters
 * in src/shared can quote launch args without depending on src/bun. agents.ts
 * re-exports them for backward compat.
 *
 * The quoting follows the platform's launch dialect, because the command line
 * these build is re-parsed by the generated wrapper script — a POSIX-quoted
 * `'\''` handed to PowerShell is a syntax error, not a quoted apostrophe
 * (decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md).
 */

import { launchDialect } from "../platform-launch";

/** Quote a string so it reaches the agent binary as exactly one argument. */
export function shellEscape(s: string): string {
	return launchDialect().nativeArg(s);
}

/** Wrap in quotes only when the value contains shell-unsafe characters.
 *  Used for short positional values (model names, mode strings) where the raw
 *  form is more readable when safe. */
export function quoteIfUnsafe(s: string): string {
	return /^[A-Za-z0-9_\-./:]+$/.test(s) ? s : shellEscape(s);
}

/** The agent binary as the first token of that command line. */
export function commandToken(s: string): string {
	return launchDialect().commandToken(s);
}
