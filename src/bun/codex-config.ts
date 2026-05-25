import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load } from "js-toml";
import { createLogger } from "./logger";
import { spawnSync } from "./spawn";
import { DEV3_CODEX_DARK_PROFILE, DEV3_CODEX_LIGHT_PROFILE } from "./theme-state";

const log = createLogger("codex-config");

/**
 * The name of the dev3 permission profile and config profile in Codex config.
 * Used as [permissions.dev3] and [profiles.dev3].
 */
export const DEV3_CODEX_PROFILE = "dev3";
export const WORKSPACE_CODEX_PROFILE = "workspace";

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

interface CodexConfigOptions {
	codexVersion?: string | null;
}

interface CodexVersion {
	major: number;
	minor: number;
	patch: number;
}

interface CodexSyntax {
	filesystemRootKey: ":project_roots" | ":workspace_roots";
	hooksFeatureKey: "codex_hooks" | "hooks";
}

const LEGACY_CODEX_SYNTAX: CodexSyntax = {
	filesystemRootKey: ":project_roots",
	hooksFeatureKey: "codex_hooks",
};

const CODEX_HOOKS_RENAME_VERSION: CodexVersion = { major: 0, minor: 129, patch: 0 };
const CODEX_WORKSPACE_ROOTS_RENAME_VERSION: CodexVersion = { major: 0, minor: 131, patch: 0 };

export function parseCodexVersion(output: string): CodexVersion | null {
	const match = output.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
	if (match == null) return null;

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function isVersionAtLeast(version: CodexVersion | null, threshold: CodexVersion): boolean {
	if (version == null) return false;
	if (version.major !== threshold.major) return version.major > threshold.major;
	if (version.minor !== threshold.minor) return version.minor > threshold.minor;
	return version.patch >= threshold.patch;
}

export function getCodexSyntaxForVersion(versionText: string | null | undefined): CodexSyntax {
	const version = versionText != null ? parseCodexVersion(versionText) : null;
	return {
		filesystemRootKey: isVersionAtLeast(version, CODEX_WORKSPACE_ROOTS_RENAME_VERSION)
			? ":workspace_roots"
			: LEGACY_CODEX_SYNTAX.filesystemRootKey,
		hooksFeatureKey: isVersionAtLeast(version, CODEX_HOOKS_RENAME_VERSION)
			? "hooks"
			: LEGACY_CODEX_SYNTAX.hooksFeatureKey,
	};
}

export function detectCodexVersion(): string | null {
	try {
		const result = spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;

		const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
		const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
		return stdout.trim() || stderr.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Ensure the Codex config.toml has:
 * 1. The dev3 worktree project trusted
 * 2. A generic [permissions.workspace] fallback profile + default_permissions
 * 3. A dedicated [permissions.dev3] permission profile with filesystem + network access
 * 4. Dedicated [profiles.dev3*] config profiles for dev3 launches
 *
 * Preserves the user's `default_permissions` when already set. If missing,
 * creates a generic `workspace` permission profile and sets it as the default
 * so Codex accepts configs that define [permissions.*] profiles.
 *
 * Uses js-toml to parse and inspect the config, but writes via text
 * manipulation to preserve comments and user formatting.
 */
export function ensureCodexConfig(
	content: string | null,
	worktreesPath: string,
	socketsPath: string,
	trustedPaths: string[] = [],
	options: CodexConfigOptions = {},
): string {
	let config = content ?? "";
	let parsed: CodexConfig = {};
	const syntax = getCodexSyntaxForVersion(options.codexVersion);
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
	config = commentOutManagedProfileThemeLines(config);
	config = migrateManagedCodexSyntax(config, syntax);
	// Re-parse after cleanup
	if (config.trim().length > 0) {
		try {
			parsed = load(config) as CodexConfig;
		} catch {
			return config;
		}
	}

	// --- 1. Ensure trusted [projects."<path>"] entries ---
	for (const trustedPath of new Set([worktreesPath, ...trustedPaths])) {
		if (!trustedPath) continue;
		if (parsed.projects?.[trustedPath] != null) continue;
		const block = `\n[projects."${trustedPath}"]\ntrust_level = "trusted"\n`;
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
			filesystemRootsHeader(DEV3_CODEX_PROFILE, syntax.filesystemRootKey),
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
		config = ensureFilesystemRootAccess(config, DEV3_CODEX_PROFILE, syntax.filesystemRootKey);
	}

	// --- 3. Ensure default_permissions points to a valid generic workspace profile ---
	if (parsed.default_permissions == null) {
		const workspacePerm = parsed.permissions?.[WORKSPACE_CODEX_PROFILE] as CodexPermissionsProfile | undefined;
		const workspaceFsHeader = `[permissions.${WORKSPACE_CODEX_PROFILE}.filesystem]`;
		const workspaceProjectRootsHeader = filesystemRootsHeader(WORKSPACE_CODEX_PROFILE, syntax.filesystemRootKey);
		const workspaceNetworkHeader = `[permissions.${WORKSPACE_CODEX_PROFILE}.network]`;

		if (workspacePerm == null) {
			const block = [
				"",
				`[permissions.${WORKSPACE_CODEX_PROFILE}.filesystem]`,
				'":minimal" = "read"',
				"",
				workspaceProjectRootsHeader,
				'"." = "write"',
				"",
				workspaceNetworkHeader,
				"enabled = true",
				"",
			].join("\n");
			config = appendBlock(config, block);
		} else {
			if (workspacePerm.filesystem == null) {
				const block = `\n${workspaceFsHeader}\n":minimal" = "read"\n`;
				config = appendBlock(config, block);
			} else {
				config = upsertSectionLine(config, workspaceFsHeader, '":minimal"', '"read"');
			}

			if (!config.includes(workspaceProjectRootsHeader)) {
				const block = `\n${workspaceProjectRootsHeader}\n"." = "write"\n`;
				config = appendBlock(config, block);
			} else {
				config = upsertSectionLine(config, workspaceProjectRootsHeader, '"."', '"write"');
			}

			if (workspacePerm.network == null) {
				const block = `\n${workspaceNetworkHeader}\nenabled = true\n`;
				config = appendBlock(config, block);
			} else if (workspacePerm.network.enabled !== true) {
				config = upsertSectionLine(config, workspaceNetworkHeader, "enabled", "true");
			}
		}

		config = upsertRootLine(config, "default_permissions", '"workspace"');
	}

	// --- 4. Ensure [profiles.dev3*] config profiles ---
	config = ensureProfileSettings(config, DEV3_CODEX_PROFILE, {
		web_search: '"live"',
	});
	config = ensureProfileSettings(config, DEV3_CODEX_LIGHT_PROFILE, {
		web_search: '"live"',
		// Codex 0.130 rejects `tui.theme` inside profiles. Leave theme
		// wiring disabled until we map the new Codex theme schema.
	});
	config = ensureProfileSettings(config, DEV3_CODEX_DARK_PROFILE, {
		web_search: '"live"',
		// Codex 0.130 rejects `tui.theme` inside profiles. Leave theme
		// wiring disabled until we map the new Codex theme schema.
	});

	// --- 5. Ensure [features] hooks/codex_hooks = true ---
	const codexHooksEnabled = parsed.features?.[syntax.hooksFeatureKey] === true;
	if (!codexHooksEnabled) {
		const featuresHeader = "[features]";
		if (!config.includes(featuresHeader)) {
			config = appendBlock(config, `\n${featuresHeader}\n${syntax.hooksFeatureKey} = true\n`);
		} else {
			config = upsertSectionLine(config, featuresHeader, syntax.hooksFeatureKey, "true");
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

function commentOutManagedProfileThemeLines(content: string): string {
	const managedHeaders = new Set([
		`[profiles.${DEV3_CODEX_LIGHT_PROFILE}]`,
		`[profiles.${DEV3_CODEX_DARK_PROFILE}]`,
	]);
	const lines = content.split("\n");
	let inManagedProfile = false;

	return lines.map((line) => {
		const trimmed = line.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inManagedProfile = managedHeaders.has(trimmed);
		}
		if (inManagedProfile && trimmed.startsWith("tui.theme")) {
			return `${line.slice(0, line.indexOf("tui.theme"))}# ${trimmed}`;
		}
		return line;
	}).join("\n");
}

function filesystemRootsHeader(profileName: string, key: CodexSyntax["filesystemRootKey"]): string {
	return `[permissions.${profileName}.filesystem."${key}"]`;
}

function migrateManagedCodexSyntax(content: string, syntax: CodexSyntax): string {
	content = migrateFilesystemRootSyntax(content, DEV3_CODEX_PROFILE, syntax.filesystemRootKey);
	content = migrateFilesystemRootSyntax(content, WORKSPACE_CODEX_PROFILE, syntax.filesystemRootKey);
	content = migrateHooksFeatureSyntax(content, syntax.hooksFeatureKey);
	return content;
}

function migrateFilesystemRootSyntax(
	content: string,
	profileName: string,
	desiredKey: CodexSyntax["filesystemRootKey"],
): string {
	const obsoleteKey = desiredKey === ":workspace_roots" ? ":project_roots" : ":workspace_roots";
	const desiredHeader = filesystemRootsHeader(profileName, desiredKey);
	const obsoleteHeader = filesystemRootsHeader(profileName, obsoleteKey);

	if (!content.includes(obsoleteHeader)) return content;
	if (content.includes(desiredHeader)) return removeSectionByHeader(content, obsoleteHeader);
	return content.replaceAll(obsoleteHeader, desiredHeader);
}

function migrateHooksFeatureSyntax(
	content: string,
	desiredKey: CodexSyntax["hooksFeatureKey"],
): string {
	const obsoleteKey = desiredKey === "hooks" ? "codex_hooks" : "hooks";
	const sectionPattern = /(\[features\]\n)([\s\S]*?)(?=\n\[|$)/;

	if (!sectionPattern.test(content)) return content;

	return content.replace(sectionPattern, (_match, header: string, body: string) => {
		const desiredPattern = new RegExp(`^[ \\t]*${desiredKey}[ \\t]*=`, "m");
		const obsoleteLinePattern = new RegExp(`^[ \\t]*${obsoleteKey}[ \\t]*=[^\\n]*\\n?`, "m");

		if (!obsoleteLinePattern.test(body)) return `${header}${body}`;
		if (desiredPattern.test(body)) {
			return `${header}${body.replace(obsoleteLinePattern, "").replace(/\n{3,}/g, "\n\n")}`;
		}
		return `${header}${body.replace(obsoleteLinePattern, (line) => line.replace(obsoleteKey, desiredKey))}`;
	});
}

function ensureFilesystemRootAccess(
	config: string,
	profileName: string,
	key: CodexSyntax["filesystemRootKey"],
): string {
	const header = filesystemRootsHeader(profileName, key);
	if (!config.includes(header)) {
		return appendBlock(config, `\n${header}\n"." = "write"\n`);
	}
	return upsertSectionLine(config, header, '"."', '"write"');
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

function upsertRootLine(config: string, key: string, value: string): string {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const keyPattern = new RegExp(`^${escapedKey}\\s*=\\s*.*$`, "m");

	if (keyPattern.test(config)) {
		return config.replace(keyPattern, `${key} = ${value}`);
	}

	const lines = config.split("\n");
	let insertIndex = 0;

	while (insertIndex < lines.length) {
		const line = lines[insertIndex];
		if (line.trim() === "" || line.trim().startsWith("#")) {
			insertIndex++;
			continue;
		}
		break;
	}

	lines.splice(insertIndex, 0, `${key} = ${value}`);
	return lines.join("\n");
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

function ensureProfileSettings(
	config: string,
	profileName: string,
	settings: Record<string, string>,
): string {
	const sectionHeader = `[profiles.${profileName}]`;
	if (!config.includes(sectionHeader)) {
		const lines = Object.entries(settings).map(([key, value]) => `${key} = ${value}`);
		return appendBlock(config, `\n${sectionHeader}\n${lines.join("\n")}\n`);
	}

	for (const [key, value] of Object.entries(settings)) {
		config = upsertSectionLine(config, sectionHeader, key, value);
	}

	return config;
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

		const updated = ensureCodexConfig(content, worktreesPath, socketsPath, [], {
			codexVersion: detectCodexVersion(),
		});

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
