/** A Claude Code plugin dev3 can install for the user from Settings → Agents. */
export interface ClaudeMod {
	id: string;
	/** `plugin@marketplace`, as `claude plugin` names it. */
	pluginId: string;
	marketplace: string;
	/** What `claude plugin marketplace add` takes: a GitHub `owner/repo`. */
	source: string;
	repoUrl: string;
}

export const CLAUDE_MODS: readonly ClaudeMod[] = [
	{
		id: "prismantis",
		pluginId: "prismantis@prismantis",
		marketplace: "prismantis",
		source: "NahumLitvin/prismantis",
		repoUrl: "https://github.com/NahumLitvin/prismantis",
	},
];

export interface ClaudeModStatus {
	modId: string;
	/** `claude plugin list` ran — false when the CLI is missing or broken. */
	claudeAvailable: boolean;
	/** Installed at user scope. */
	installed: boolean;
	enabled: boolean;
	version: string | null;
}
