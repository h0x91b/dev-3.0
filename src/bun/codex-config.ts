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
 * Remove the [permissions.network] section that we previously injected.
 * Codex 0.114+ requires `default_permissions` when `[permissions]` is present,
 * and our injected section breaks startup. We now use `--sandbox never` instead.
 *
 * Returns the cleaned content, or null if input was null (file doesn't exist).
 */
export function cleanupCodexConfig(content: string | null): string | null {
	if (content == null || content.length === 0) return content;

	// Find [permissions.network] section and remove it line-by-line.
	// Section body = non-empty lines that don't start with '[' (a new section header).
	const lines = content.split("\n");
	const out: string[] = [];
	let inSection = false;
	let trailingBlanks = 0;

	for (const line of lines) {
		if (!inSection) {
			// Detect uncommented section header
			if (line.trim() === "[permissions.network]") {
				inSection = true;
				// Drop any trailing blank lines we accumulated before this header
				while (trailingBlanks > 0) {
					out.pop();
					trailingBlanks--;
				}
				continue;
			}
			// Track trailing blank lines so we can remove the gap before the section
			if (line.trim() === "") {
				trailingBlanks++;
			} else {
				trailingBlanks = 0;
			}
			out.push(line);
		} else {
			// Inside the section — skip lines until next section header or non-key content
			if (line.startsWith("[")) {
				// Next section starts — stop skipping
				inSection = false;
				trailingBlanks = 0;
				out.push(line);
			}
			// Skip key=value lines, blank lines, and comments within the section
		}
	}

	const cleaned = out.join("\n");

	// Collapse 3+ consecutive newlines down to 2 (one blank line)
	return cleaned.replace(/\n{3,}/g, "\n\n");
}

/**
 * Read, clean up, and write the Codex config.toml.
 * Removes the [permissions.network] section we previously injected.
 * Called on app startup from installAgentSkills().
 */
export function cleanupCodexConfigFile(homePath: string): void {
	const configPath = `${homePath}/.codex/config.toml`;

	try {
		let content: string | null = null;
		try {
			content = readFileSync(configPath, "utf-8");
		} catch {
			// File doesn't exist — nothing to clean up
			return;
		}

		const updated = cleanupCodexConfig(content);

		// Only write if changed
		if (updated !== content) {
			writeFileSync(configPath, updated!, "utf-8");
			log.info("Codex config.toml cleaned up (removed [permissions.network])", { path: configPath });
		}
	} catch (err) {
		log.warn("Failed to clean up Codex config.toml (non-fatal)", {
			error: String(err),
		});
	}
}
