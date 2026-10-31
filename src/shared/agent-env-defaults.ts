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
