/** Placeholders: `{home}` is the user's home directory, `{projectPath}` the project's main checkout. */
function expandAgentEnvDefault(value: string, project: { path: string; name: string }, home: string): string {
	return value
		.replaceAll("{home}", home)
		.replaceAll("{projectPath}", project.path)
		.replaceAll("{projectName}", project.name);
}

/**
 * Fill the keys a project's own env leaves unset from the global defaults.
 * A key the project sets - even to an empty string - always keeps its value.
 */
export function applyAgentEnvDefaults(
	projectEnv: Record<string, string>,
	defaults: Record<string, string> | undefined,
	project: { path: string; name: string },
	home: string,
): Record<string, string> {
	if (!defaults) return projectEnv;
	const filled: Record<string, string> = {};
	for (const [key, value] of Object.entries(defaults)) {
		if (!(key in projectEnv)) filled[key] = expandAgentEnvDefault(value, project, home);
	}
	return Object.keys(filled).length > 0 ? { ...filled, ...projectEnv } : projectEnv;
}

/** The default that points Claude Code at each project's own `.claude` instead of `~/.claude`. */
export const PROJECT_CLAUDE_CONFIG_DIR_DEFAULT = "{projectPath}/.claude";

export function usesProjectClaudeConfigDir(defaults: Record<string, string> | undefined): boolean {
	return defaults?.CLAUDE_CONFIG_DIR === PROJECT_CLAUDE_CONFIG_DIR_DEFAULT;
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
