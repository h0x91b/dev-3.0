/**
 * Shape check for a path an agent, the CLI, or the renderer handed us.
 *
 * This is NOT a security boundary — every fully-qualified path on the machine
 * passes, so widening it opens no hole. It only answers "did the caller give me
 * a fully-qualified path, or a fragment I would resolve against an arbitrary
 * cwd?", and rejects `..` so a handed-in path cannot walk upwards. Sandboxing a
 * path to a directory is a separate job the callers do not ask for.
 *
 * Windows matters here: an uploaded path looks like `C:/Users/me/.dev3.0/...`,
 * which a POSIX-only `startsWith("/")` check rejects outright.
 */
export function isFullyQualifiedPath(path: string, platform: string): boolean {
	// Conservative on purpose: a literal ".." anywhere is refused, even inside a
	// filename like "a..b.png". Callers never need such names.
	if (!path || path.includes("..")) return false;
	// POSIX root. Also accepted on Windows — Bun and Node resolve "/x" there.
	if (path.startsWith("/")) return true;
	if (platform !== "win32") return false;
	// UNC share: \\server\share\...
	if (/^\\\\[^\\/]/.test(path)) return true;
	// Drive-qualified: C:\... or C:/... — "C:foo" is drive-RELATIVE and refused.
	return /^[A-Za-z]:[\\/]/.test(path);
}
