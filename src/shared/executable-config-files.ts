/**
 * Repo files whose CONTENT dev3 or its agents turn into running processes.
 *
 * A hostile `setupScript` is one line of JSON in a thirty-file pull request —
 * the least-read spot in any diff. The diff viewer marks these files so the
 * reviewer reads the commands, not just the shape of the change.
 *
 * Paths are repo-root-relative, exactly as a diff reports them.
 */
const EXECUTABLE_CONFIG_PATHS: ReadonlySet<string> = new Set([
	".dev3/config.json", // setupScript / devScript / cleanupScript / env / builtinColumnAgents
	".dev3/config.local.json", // same fields; gitignored only where dev3 wrote that rule
	".mcp.json", // MCP server command lines an agent may start
	".claude/settings.json", // Claude hooks, run on agent events
	".claude/settings.local.json",
]);

/** True when a diff path names a file dev3 or an agent executes by itself. */
export function isExecutableConfigPath(path: string | null | undefined): boolean {
	if (!path) return false;
	return EXECUTABLE_CONFIG_PATHS.has(path.replace(/^\.\//, "").trim());
}
