/** Placeholders: `{home}` is the user's home directory, `{projectPath}` the project's main checkout. */
function expandAgentEnvDefault(value: string, project: { path: string; name: string }, home: string): string {
	return value
		.replaceAll("{home}", home)
		.replaceAll("{projectPath}", project.path)
		.replaceAll("{projectName}", project.name);
}

/**
 * Fill the keys a project's own env leaves unset from the global defaults; a key the project
 * sets, even to "", keeps its value. A `CLAUDE_CONFIG_DIR` default built from `{projectPath}`
 * applies only when `claudeConfigDirAllowed` accepts its expansion.
 */
export function applyAgentEnvDefaults(
	projectEnv: Record<string, string>,
	defaults: Record<string, string> | undefined,
	project: { path: string; name: string },
	home: string,
	claudeConfigDirAllowed: (dir: string) => boolean,
): Record<string, string> {
	if (!defaults) return projectEnv;
	const filled: Record<string, string> = {};
	for (const [key, value] of Object.entries(defaults)) {
		if (key in projectEnv) continue;
		const expanded = expandAgentEnvDefault(value, project, home);
		if (key === "CLAUDE_CONFIG_DIR" && value.includes("{projectPath}") && !claudeConfigDirAllowed(expanded)) continue;
		filled[key] = expanded;
	}
	return Object.keys(filled).length > 0 ? { ...filled, ...projectEnv } : projectEnv;
}

/** The default that points Claude Code at each project's own `.claude` instead of `~/.claude`. */
export const PROJECT_CLAUDE_CONFIG_DIR_DEFAULT = "{projectPath}/.claude";

/** True for the switch's default, trailing slashes included. */
export function usesProjectClaudeConfigDir(defaults: Record<string, string> | undefined): boolean {
	return defaults?.CLAUDE_CONFIG_DIR?.trim().replace(/\/+$/, "") === PROJECT_CLAUDE_CONFIG_DIR_DEFAULT;
}

/** Turn the per-project Claude folder default on or off, leaving every other key alone. */
export function withProjectClaudeConfigDir(
	defaults: Record<string, string> | undefined,
	enabled: boolean,
): Record<string, string> | undefined {
	const { CLAUDE_CONFIG_DIR: _dropped, ...rest } = defaults ?? {};
	const next = enabled ? { ...rest, CLAUDE_CONFIG_DIR: PROJECT_CLAUDE_CONFIG_DIR_DEFAULT } : rest;
	return Object.keys(next).length > 0 ? next : undefined;
}
