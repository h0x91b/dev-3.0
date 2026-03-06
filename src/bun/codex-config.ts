import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load } from "js-toml";
import { createLogger } from "./logger";

const log = createLogger("codex-config");

interface CodexConfig {
	projects?: Record<string, { trust_level?: string; sandbox_mode?: string }>;
	permissions?: {
		network?: {
			enabled?: boolean;
			allow_unix_sockets?: string[];
		};
	};
}

/**
 * Ensure the Codex config.toml has the dev3 worktree project trusted
 * and permissions.network configured for Unix socket access.
 *
 * Uses js-toml to parse and inspect the config, but writes via text
 * manipulation to preserve comments and user formatting.
 *
 * @param content - Existing config content, or null if file doesn't exist.
 * @param worktreesPath - Absolute path to dev3 worktrees directory.
 * @param socketsPath - Absolute path to dev3 sockets directory.
 */
export function ensureCodexConfig(
	content: string | null,
	worktreesPath: string,
	socketsPath: string,
): string {
	let config = content ?? "";
	let parsed: CodexConfig = {};

	if (config.trim().length > 0) {
		try {
			parsed = load(config) as CodexConfig;
		} catch {
			// If TOML is unparseable, don't risk corrupting it — bail out.
			log.warn("Could not parse existing Codex config.toml, skipping patching");
			return config;
		}
	}

	// --- 1. Ensure [projects."<worktreesPath>"] with trust_level = "trusted" ---
	const hasProject = parsed.projects?.[worktreesPath] != null;
	if (!hasProject) {
		const block = `\n[projects."${worktreesPath}"]\ntrust_level = "trusted"\n`;
		config = appendBlock(config, block);
	}

	// --- 2. Ensure [permissions.network] section with required keys ---
	const network = parsed.permissions?.network;
	const hasNetworkSection = network != null;
	const hasEnabled = network?.enabled === true;
	const existingSockets = network?.allow_unix_sockets ?? [];
	const hasSockets = existingSockets.includes(socketsPath);

	if (!hasNetworkSection) {
		// Add entire section
		const block = `\n[permissions.network]\nenabled = true\nallow_unix_sockets = ["${socketsPath}"]\n`;
		config = appendBlock(config, block);
	} else {
		// Section exists — patch missing keys
		if (!hasEnabled) {
			config = insertAfterSectionHeader(config, "[permissions.network]", "enabled = true");
		}

		if (!hasSockets) {
			if (existingSockets.length === 0) {
				// No allow_unix_sockets key at all — check if it's in the text
				if (config.includes("allow_unix_sockets")) {
					// Key exists but empty or with other values — append our path
					config = config.replace(
						/allow_unix_sockets\s*=\s*\[([^\]]*)\]/,
						(_, inner) => {
							const trimmed = inner.trim();
							const newValue = trimmed
								? `${trimmed}, "${socketsPath}"`
								: `"${socketsPath}"`;
							return `allow_unix_sockets = [${newValue}]`;
						},
					);
				} else {
					config = insertAfterSectionHeader(
						config,
						"[permissions.network]",
						`allow_unix_sockets = ["${socketsPath}"]`,
					);
				}
			} else {
				// Has allow_unix_sockets with other paths — append ours
				config = config.replace(
					/allow_unix_sockets\s*=\s*\[([^\]]*)\]/,
					(_, inner) => {
						const trimmed = inner.trim();
						return `allow_unix_sockets = [${trimmed}, "${socketsPath}"]`;
					},
				);
			}
		}
	}

	return config;
}

/**
 * Append a block to config, ensuring proper newline separation.
 */
function appendBlock(config: string, block: string): string {
	if (config.length === 0 || config.trim().length === 0) {
		return block.trimStart();
	}
	if (!config.endsWith("\n")) {
		config += "\n";
	}
	return config + block;
}

/**
 * Insert a key-value line right after a section header.
 */
function insertAfterSectionHeader(
	config: string,
	sectionHeader: string,
	line: string,
): string {
	const idx = config.indexOf(sectionHeader);
	if (idx === -1) return config;

	const insertPos = idx + sectionHeader.length;
	const nextNewline = config.indexOf("\n", insertPos);
	if (nextNewline === -1) {
		return config + "\n" + line + "\n";
	}

	return (
		config.slice(0, nextNewline + 1) +
		line +
		"\n" +
		config.slice(nextNewline + 1)
	);
}

/**
 * Read, patch, and write the Codex config.toml.
 * Called on app startup from installAgentSkills().
 */
export function ensureCodexConfigFile(homePath: string): void {
	const configPath = `${homePath}/.codex/config.toml`;
	const worktreesPath = `${homePath}/.dev3.0/worktrees`;
	const socketsPath = `${homePath}/.dev3.0/sockets`;

	try {
		let content: string | null = null;
		try {
			content = readFileSync(configPath, "utf-8");
		} catch {
			// File doesn't exist
		}

		const updated = ensureCodexConfig(content, worktreesPath, socketsPath);

		// Only write if changed
		if (updated !== content) {
			const dir = dirname(configPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(configPath, updated, "utf-8");
			log.info("Codex config.toml updated for dev3 socket access", { path: configPath });
		}
	} catch (err) {
		log.warn("Failed to update Codex config.toml (non-fatal)", {
			error: String(err),
		});
	}
}
