/**
 * Whether a platform can carry the CLI ↔ app transport.
 *
 * The transport is a Unix domain socket at `~/.dev3.0/sockets/<pid>.sock`, bound
 * with `Bun.listen({ unix })` and discovered by the CLI as a plain file in that
 * directory. Windows has no such socket — the equivalent is a named pipe, which
 * lives in a different address space (`\\.\pipe\…`) with no directory to scan,
 * so it needs a real discovery mechanism rather than a path rewrite.
 *
 * Seq 1296 owns that work. Until then this predicate is the single seam: both the
 * server (`startSocketServer`) and any caller that needs to know whether the CLI
 * can reach the app ask here. The app boots with the transport reported
 * unavailable instead of throwing out of `Bun.listen` before its first window is
 * created — loudly unavailable, never silently half-working.
 *
 * Lives in `shared/` with zero imports so the boot path and unit tests can reach
 * it without pulling in the electrobun runtime.
 */
export function cliSocketTransportSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}
