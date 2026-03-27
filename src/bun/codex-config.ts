import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load } from "js-toml";
import { createLogger } from "./logger";

const log = createLogger("codex-config");

/**
 * The name of the dev3 permission profile and config profile in Codex config.
 * Used as [permissions.dev3] and [profiles.dev3].
 */
export const DEV3_CODEX_PROFILE = "dev3";

interface CodexPermissionsProfile {
	filesystem?: Record<string, unknown>;
	network?: {
		enabled?: boolean;
		allow_unix_sockets?: string[];
	};
}

interface CodexConfig {
	default_permissions?: string;
	features?: Record<string, unknown>;
	projects?: Record<string, { trust_level?: string; sandbox_mode?: string }>;
	profiles?: Record<string, Record<string, unknown>>;
	permissions?: Record<string, CodexPermissionsProfile | undefined>;
}

/**
 * Ensure the Codex config.toml has:
 * 1. The dev3 worktree project trusted
 * 2. A dedicated [permissions.dev3] permission profile with filesystem + network access
 * 3. A dedicated [profiles.dev3] config profile for dev3 launches
 *
 * Does NOT touch the user's `default_permissions` — dev3 selects its own
 * permission profile at launch time via `-c 'default_permissions="dev3"'`.
 *
 * Uses js-toml to parse and inspect the config, but writes via text
 * manipulation to preserve comments and user formatting.
 */
export function ensureCodexConfig(
	content: string | null,
	worktreesPath: string,
	socketsPath: string,
): string {
	let config = content ?? "";
	let parsed: CodexConfig = {};
	// Derive absolute paths from worktreesPath (e.g. /Users/x/.dev3.0/worktrees)
	const dev3Home = dirname(worktreesPath); // /Users/x/.dev3.0
	const userHome = dirname(dev3Home); // /Users/x

	if (config.trim().length > 0) {
		try {
			parsed = load(config) as CodexConfig;
		} catch {
			log.warn("Could not parse existing Codex config.toml, skipping patching");
			return config;
		}
	}

	// --- 0. Clean up legacy sections ---
	config = cleanupLegacySections(config);
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

	// --- 2. Ensure [permissions.dev3] permission profile ---
	const dev3Perm = parsed.permissions?.[DEV3_CODEX_PROFILE] as CodexPermissionsProfile | undefined;

	if (dev3Perm == null) {
		// Add entire permissions.dev3 block
		const block = [
			"",
			`[permissions.${DEV3_CODEX_PROFILE}.filesystem]`,
			'":minimal" = "read"',
			`"${userHome}/.codex/skills" = "read"`,
			`"${userHome}/.agents/skills" = "read"`,
			`"${dev3Home}" = "write"`,
			"",
			`[permissions.${DEV3_CODEX_PROFILE}.filesystem.":project_roots"]`,
			'"." = "write"',
			"",
			`[permissions.${DEV3_CODEX_PROFILE}.network]`,
			"enabled = true",
			`allow_unix_sockets = ["${socketsPath}"]`,
			"",
		].join("\n");
		config = appendBlock(config, block);
	} else {
		// Permission profile exists — ensure network section has our socket
		const dev3Net = dev3Perm.network;
		const netHeader = `[permissions.${DEV3_CODEX_PROFILE}.network]`;

		if (dev3Net == null) {
			const block = `\n${netHeader}\nenabled = true\nallow_unix_sockets = ["${socketsPath}"]\n`;
			config = appendBlock(config, block);
		} else {
			if (dev3Net.enabled !== true) {
				config = insertAfterSectionHeader(config, netHeader, "enabled = true");
			}
			const existingSockets = dev3Net.allow_unix_sockets ?? [];
			if (!existingSockets.includes(socketsPath)) {
				if (existingSockets.length === 0 && !config.includes("allow_unix_sockets")) {
					config = insertAfterSectionHeader(config, netHeader, `allow_unix_sockets = ["${socketsPath}"]`);
				} else {
					// Append to existing array under dev3.network specifically
					const pattern = new RegExp(
						`(\\[permissions\\.${DEV3_CODEX_PROFILE}\\.network\\][^\\[]*?)allow_unix_sockets\\s*=\\s*\\[([^\\]]*)\\]`,
						"s",
					);
					config = config.replace(pattern, (_match, prefix, inner) => {
						const trimmed = inner.trim();
						const newValue = trimmed
							? `${trimmed}, "${socketsPath}"`
							: `"${socketsPath}"`;
						return `${prefix}allow_unix_sockets = [${newValue}]`;
					});
				}
			}
		}

		// Ensure skill directories are readable and dev3 data dir is writable
		const fsHeader = `[permissions.${DEV3_CODEX_PROFILE}.filesystem]`;
		const requiredFsPaths = [
			`"${userHome}/.codex/skills" = "read"`,
			`"${userHome}/.agents/skills" = "read"`,
			`"${dev3Home}" = "write"`,
		];
		for (const fsLine of requiredFsPaths) {
			if (!config.includes(fsLine)) {
				config = insertAfterSectionHeader(config, fsHeader, fsLine);
			}
		}
	}

	// --- 3. Ensure [profiles.dev3] config profile ---
	const dev3Profile = parsed.profiles?.[DEV3_CODEX_PROFILE];
	if (dev3Profile == null) {
		const block = [
			"",
			`[profiles.${DEV3_CODEX_PROFILE}]`,
			'web_search = "live"',
			"",
		].join("\n");
		config = appendBlock(config, block);
	}

	// --- 4. Ensure [features] codex_hooks = true ---
	const codexHooksEnabled = parsed.features?.codex_hooks === true;
	if (!codexHooksEnabled) {
		const featuresHeader = "[features]";
		if (!config.includes(featuresHeader)) {
			config = appendBlock(config, `\n${featuresHeader}\ncodex_hooks = true\n`);
		} else {
			config = upsertSectionLine(config, featuresHeader, "codex_hooks", "true");
		}
	}

	return config;
}

/**
 * Remove legacy [permissions.network] section injected by early dev3 versions
 * (old flat syntax, pre-0.114). Only removes if it contains `.dev3.0/sockets`.
 *
 * Does NOT touch [permissions.workspace.*] — those may be the user's own config.
 */
function cleanupLegacySections(content: string): string {
	if (content.includes(".dev3.0/sockets")) {
		content = removeSectionByHeader(content, "[permissions.network]");
	}
	return content;
}

/**
 * Remove a TOML section by its header. Removes the header line and all
 * key=value/blank/comment lines until the next section header.
 */
function removeSectionByHeader(content: string, header: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let inSection = false;
	let trailingBlanks = 0;

	for (const line of lines) {
		if (!inSection) {
			if (line.trim() === header) {
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
		}
	}

	return out.join("\n").replace(/\n{3,}/g, "\n\n");
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

function upsertSectionLine(
	config: string,
	sectionHeader: string,
	key: string,
	value: string,
): string {
	const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const sectionPattern = new RegExp(`(${escapedHeader}\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
	const existingKeyPattern = new RegExp(`^${escapedKey}\\s*=\\s*.*$`, "m");

	if (!sectionPattern.test(config)) {
		return appendBlock(config, `\n${sectionHeader}\n${key} = ${value}\n`);
	}

	return config.replace(sectionPattern, (_match, header, body) => {
		if (existingKeyPattern.test(body)) {
			return `${header}${body.replace(existingKeyPattern, `${key} = ${value}`)}`;
		}
		return `${header}${key} = ${value}\n${body}`;
	});
}

/**
 * Read, patch, and write the Codex config.toml.
 * Ensures a dedicated dev3 permission profile and config profile.
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
			log.info("Codex config.toml patched with dev3 profiles", { path: configPath });
		}
	} catch (err) {
		log.warn("Failed to patch Codex config.toml (non-fatal)", {
			error: String(err),
		});
	}
}
