/**
 * Low-level shell-quoting helpers shared by every agent adapter.
 *
 * Pure string utilities (no I/O). Moved from src/bun/agents.ts so the adapters
 * in src/shared can quote launch args without depending on src/bun. agents.ts
 * re-exports them for backward compat.
 */

/** POSIX single-quote a string (safe for any content). */
export function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Wrap in single quotes only when the value contains shell-unsafe characters.
 *  Used for short positional values (model names, mode strings) where the raw
 *  form is more readable when safe. */
export function quoteIfUnsafe(s: string): string {
	return /^[A-Za-z0-9_\-./:]+$/.test(s) ? s : shellEscape(s);
}
