/** A Claude Code plugin dev3 can install for the user from Settings → Agents. */
export interface ClaudeMod {
	id: string;
	/** `plugin@marketplace`, as `claude plugin` names it. */
	pluginId: string;
	marketplace: string;
	/** Git URL of the marketplace repo. */
	marketplaceUrl: string;
	/** Tag the marketplace is pinned to. Its manifest pins the plugin source by commit SHA,
	 *  so a release reaches users only when dev3 bumps this. `#<sha>` is refused by the CLI. */
	marketplaceRef: string;
	/** The plugin version that tag installs; checked after every install. */
	pinnedVersion: string;
	repoUrl: string;
}

export const CLAUDE_MODS: readonly ClaudeMod[] = [
	{
		id: "prismantis",
		pluginId: "prismantis@prismantis",
		marketplace: "prismantis",
		marketplaceUrl: "https://github.com/NahumLitvin/prismantis.git",
		// Reviewed: hooks at b76b9156 (plugin 0.40.0) make no network, process or file-write calls.
		marketplaceRef: "v0.41.0",
		pinnedVersion: "0.40.0",
		repoUrl: "https://github.com/NahumLitvin/prismantis",
	},
];

export interface ClaudeModStatus {
	modId: string;
	/** `claude plugin list` ran — false when the CLI is missing or broken. */
	claudeAvailable: boolean;
	/** Installed at user scope in every Claude config dir dev3 manages. */
	installed: boolean;
	enabled: boolean;
	/** Version in the default config dir. */
	version: string | null;
	pinnedVersion: string;
	/** Every config dir runs `pinnedVersion`. */
	current: boolean;
}
