import { readFileSync, writeFileSync } from "node:fs";
import { load } from "js-toml";
import { createLogger } from "./logger";

const log = createLogger("codex-config");

interface CodexPermissionsWorkspace {
	filesystem?: Record<string, unknown>;
	network?: {
		enabled?: boolean;
		allow_unix_sockets?: string[];
	};
}

interface CodexConfig {
	default_permissions?: string;
	projects?: Record<string, { trust_level?: string; sandbox_mode?: string }>;
	permissions?: {
		// Old syntax (pre-0.114)
		network?: {
			enabled?: boolean;
			allow_unix_sockets?: string[];
		};
		// New syntax
		workspace?: CodexPermissionsWorkspace;
	};
}

/**
 * Ensure the Codex config.toml has:
 * 1. The dev3 worktree project trusted
 * 2. Modern workspace permissions with network access for Unix sockets
 *
 * Uses js-toml to parse and inspect the config, but writes via text
 * manipulation to preserve comments and user formatting.
 *
 * Also cleans up the old [permissions.network] section if present
 * (it was injected by earlier dev3 versions and is now obsolete).
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
			log.warn("Could not parse existing Codex config.toml, skipping patching");
			return config;
		}
	}

	// --- 0. Clean up old [permissions.network] section if it has dev3 sockets ---
	config = cleanupOldPermissionsNetwork(config);
	// Re-parse after cleanup
	if (config.trim().length > 0) {
		try {
			parsed = load(config) as CodexConfig;
		} catch {
			return config;
		}
	}

	// --- 1. Ensure [projects."<worktreesPath>"] with trust_level = "trusted" ---
	const hasProject = parsed.projects?.[worktreesPath] != null;
	if (!hasProject) {
		const block = `\n[projects."${worktreesPath}"]\ntrust_level = "trusted"\n`;
		config = appendBlock(config, block);
	}

	// --- 2. Ensure default_permissions = "workspace" ---
	if (parsed.default_permissions !== "workspace") {
		if (parsed.default_permissions != null) {
			// Replace existing value
			config = config.replace(
				/default_permissions\s*=\s*"[^"]*"/,
				'default_permissions = "workspace"',
			);
		} else {
			// Add at the top (after any leading comments/blank lines, before first section)
			config = insertTopLevelKey(config, 'default_permissions = "workspace"');
		}
	}

	// --- 3. Ensure [permissions.workspace.filesystem] sections ---
	const wsFs = parsed.permissions?.workspace?.filesystem;
	if (wsFs == null) {
		const block = `\n[permissions.workspace.filesystem]\n":minimal" = "read"\n\n[permissions.workspace.filesystem.":project_roots"]\n"." = "write"\n`;
		config = appendBlock(config, block);
	}

	// --- 4. Ensure [permissions.workspace.network] section ---
	const wsNet = parsed.permissions?.workspace?.network;
	const hasWsNetworkSection = wsNet != null;
	const hasWsEnabled = wsNet?.enabled === true;
	const existingWsSockets = wsNet?.allow_unix_sockets ?? [];
	const hasWsSockets = existingWsSockets.includes(socketsPath);

	if (!hasWsNetworkSection) {
		const block = `\n[permissions.workspace.network]\nenabled = true\nallow_unix_sockets = ["${socketsPath}"]\n`;
		config = appendBlock(config, block);
	} else {
		if (!hasWsEnabled) {
			config = insertAfterSectionHeader(config, "[permissions.workspace.network]", "enabled = true");
		}

		if (!hasWsSockets) {
			if (existingWsSockets.length === 0) {
				if (config.includes("allow_unix_sockets")) {
					// Find the one under [permissions.workspace.network], not other sections
					// Simple approach: just append if not found
					config = config.replace(
						/(\[permissions\.workspace\.network\][^\[]*?)allow_unix_sockets\s*=\s*\[([^\]]*)\]/s,
						(_match, prefix, inner) => {
							const trimmed = inner.trim();
							const newValue = trimmed
								? `${trimmed}, "${socketsPath}"`
								: `"${socketsPath}"`;
							return `${prefix}allow_unix_sockets = [${newValue}]`;
						},
					);
				} else {
					config = insertAfterSectionHeader(
						config,
						"[permissions.workspace.network]",
						`allow_unix_sockets = ["${socketsPath}"]`,
					);
				}
			} else {
				// Has allow_unix_sockets with other paths under workspace.network — append ours
				config = config.replace(
					/(\[permissions\.workspace\.network\][^\[]*?)allow_unix_sockets\s*=\s*\[([^\]]*)\]/s,
					(_match, prefix, inner) => {
						const trimmed = inner.trim();
						return `${prefix}allow_unix_sockets = [${trimmed}, "${socketsPath}"]`;
					},
				);
			}
		}
	}

	return config;
}

/**
 * Remove the old-style [permissions.network] section that was injected
 * by earlier dev3 versions. Only removes if it contains `.dev3.0/sockets`.
 */
function cleanupOldPermissionsNetwork(content: string): string {
	if (!content.includes(".dev3.0/sockets")) return content;

	const lines = content.split("\n");
	const out: string[] = [];
	let inSection = false;
	let trailingBlanks = 0;

	for (const line of lines) {
		if (!inSection) {
			if (line.trim() === "[permissions.network]") {
				inSection = true;
				while (trailingBlanks > 0) {
					out.pop();
					trailingBlanks--;
				}
				continue;
			}
			if (line.trim() === "") {
				trailingBlanks++;
			} else {
				trailingBlanks = 0;
			}
			out.push(line);
		} else {
			if (line.startsWith("[")) {
				inSection = false;
				trailingBlanks = 0;
				out.push(line);
			}
			// Skip key=value lines, blank lines, and comments within the section
		}
	}

	const cleaned = out.join("\n");
	return cleaned.replace(/\n{3,}/g, "\n\n");
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
 * Insert a top-level key before the first section header.
 * If no section headers exist, append at the end.
 */
function insertTopLevelKey(config: string, keyLine: string): string {
	// Find first line that starts with '['
	const lines = config.split("\n");
	let firstSectionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("[")) {
			firstSectionIdx = i;
			break;
		}
	}

	if (firstSectionIdx === -1) {
		// No sections — append at the end
		if (config.trim().length === 0) return keyLine + "\n";
		return config + (config.endsWith("\n") ? "" : "\n") + keyLine + "\n";
	}

	// Insert before first section, with a blank line separator
	lines.splice(firstSectionIdx, 0, keyLine, "");
	return lines.join("\n");
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
 * Ensures modern workspace permissions for dev3 socket access.
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
			// File doesn't exist — will create with defaults
		}

		const updated = ensureCodexConfig(content, worktreesPath, socketsPath);

		if (updated !== content) {
			writeFileSync(configPath, updated, "utf-8");
			log.info("Codex config.toml patched with workspace permissions", { path: configPath });
		}
	} catch (err) {
		log.warn("Failed to patch Codex config.toml (non-fatal)", {
			error: String(err),
		});
	}
}
