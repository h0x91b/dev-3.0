import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MODS, type ClaudeMod, type ClaudeModStatus } from "../../shared/types";
import { defaultAccountPaths, listClaudeAccountDirs } from "../agent-accounts";
import { createLogger } from "../logger";
import { spawn } from "../spawn";

const log = createLogger("claude-mods");

/** Long enough for a marketplace clone on a slow link; short enough that a stalled
 *  git (credential helper, dead network) cannot hold the change queue forever. */
export const CLAUDE_COMMAND_TIMEOUT_MS = 90_000;

/** `undefined` targets the default config dir (~/.claude). */
type ConfigDir = string | undefined;

class ClaudeTimeoutError extends Error {}

async function runClaude(args: string[], configDir: ConfigDir): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = spawn(["claude", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// An undefined value drops the key, so an inherited CLAUDE_CONFIG_DIR cannot redirect the change.
		env: { CLAUDE_CONFIG_DIR: configDir, GIT_TERMINAL_PROMPT: "0" },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			proc.kill(9);
			reject(new ClaudeTimeoutError(`claude ${args.slice(0, 3).join(" ")} timed out after ${CLAUDE_COMMAND_TIMEOUT_MS / 1000}s`));
		}, CLAUDE_COMMAND_TIMEOUT_MS);
	});
	const run = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	try {
		const [stdout, stderr, exitCode] = await Promise.race([run, timeout]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function runClaudeOrThrow(args: string[], configDir: ConfigDir): Promise<string> {
	const { exitCode, stdout, stderr } = await runClaude(args, configDir);
	if (exitCode !== 0) {
		const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ");
		throw new Error(`claude ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}): ${detail}`);
	}
	return stdout;
}

async function readJsonList<T>(args: string[], configDir: ConfigDir): Promise<T[] | null> {
	try {
		const { exitCode, stdout } = await runClaude(args, configDir);
		if (exitCode !== 0) return null;
		const parsed = JSON.parse(stdout) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : null;
	} catch (err) {
		if (err instanceof ClaudeTimeoutError) throw err;
		return null;
	}
}

function findMod(modId: string): ClaudeMod {
	const mod = CLAUDE_MODS.find((m) => m.id === modId);
	if (!mod) throw new Error(`Unknown Claude mod: ${modId}`);
	return mod;
}

/** Where a plugin install lives: `plugins/` holds the install, `settings.json` the enabled flag. */
const PLUGIN_ENTRIES = ["plugins", "settings.json"];

/** An account entry that is not a link into ~/.claude. scaffoldClaudeAccountDir never replaces
 *  what an account already had, so such an account misses an install made in ~/.claude.
 *  A missing entry is not separate: the next launch of that account links it. */
function hasSeparateEntry(accountDir: string, entry: string, claudeHome: string): boolean {
	const slot = join(accountDir, entry);
	try {
		lstatSync(slot);
	} catch {
		return false;
	}
	try {
		return realpathSync(slot) !== realpathSync(join(claudeHome, entry));
	} catch {
		return true;
	}
}

/** The default config dir, then every managed account that keeps its own plugin state. */
function claudeConfigDirs(): ConfigDir[] {
	const { claudeHome } = defaultAccountPaths();
	const separate = listClaudeAccountDirs().filter((dir) => PLUGIN_ENTRIES.some((entry) => hasSeparateEntry(dir, entry, claudeHome)));
	return [undefined, ...separate];
}

interface InstalledPlugin {
	id: string;
	version?: string;
	scope?: string;
	enabled?: boolean;
}

interface DirStatus {
	installed: boolean;
	enabled: boolean;
	version: string | null;
}

async function readDirStatus(mod: ClaudeMod, configDir: ConfigDir): Promise<DirStatus | null> {
	const plugins = await readJsonList<InstalledPlugin>(["plugin", "list", "--json"], configDir);
	if (plugins === null) return null;
	const entry = plugins.find((p) => p.id === mod.pluginId && (p.scope ?? "user") === "user");
	return { installed: !!entry, enabled: entry?.enabled === true, version: entry?.version ?? null };
}

export async function getClaudeModStatus(modId: string): Promise<ClaudeModStatus> {
	const mod = findMod(modId);
	const dirs = claudeConfigDirs();
	const statuses: (DirStatus | null)[] = [];
	for (const dir of dirs) statuses.push(await readDirStatus(mod, dir));
	const [primary] = statuses;
	if (!primary) {
		return { modId, claudeAvailable: false, installed: false, enabled: false, version: null, pinnedVersion: mod.pinnedVersion, current: false };
	}
	return {
		modId,
		claudeAvailable: true,
		installed: statuses.every((s) => s?.installed === true),
		enabled: statuses.every((s) => s?.enabled === true),
		version: primary.version,
		pinnedVersion: mod.pinnedVersion,
		current: statuses.every((s) => s?.version === mod.pinnedVersion),
	};
}

interface MarketplaceEntry {
	name: string;
	url?: string;
	ref?: string;
}

/** Re-pinning removes the old marketplace, which also uninstalls its plugins — callers read
 *  the plugin's state only after this. */
async function ensurePinnedMarketplace(mod: ClaudeMod, configDir: ConfigDir): Promise<void> {
	const marketplaces = (await readJsonList<MarketplaceEntry>(["plugin", "marketplace", "list", "--json"], configDir)) ?? [];
	const existing = marketplaces.find((m) => m.name === mod.marketplace);
	if (existing?.url === mod.marketplaceUrl && existing.ref === mod.marketplaceRef) return;
	if (existing) await runClaudeOrThrow(["plugin", "marketplace", "remove", mod.marketplace], configDir);
	await runClaudeOrThrow(["plugin", "marketplace", "add", `${mod.marketplaceUrl}#${mod.marketplaceRef}`], configDir);
}

/** On: land on the pinned version, enabled. Off: disable — uninstalling would drop the
 *  plugin's options, which live in settings.json under `pluginConfigs`. */
async function applyInDir(mod: ClaudeMod, enabled: boolean, configDir: ConfigDir): Promise<void> {
	if (!enabled) {
		const status = await readDirStatus(mod, configDir);
		if (!status) throw new Error("claude plugin list failed");
		if (status.enabled) await runClaudeOrThrow(["plugin", "disable", mod.pluginId], configDir);
		return;
	}

	await ensurePinnedMarketplace(mod, configDir);
	const status = await readDirStatus(mod, configDir);
	if (!status) throw new Error("claude plugin list failed");
	if (status.installed && status.version !== mod.pinnedVersion) {
		await runClaudeOrThrow(["plugin", "uninstall", mod.pluginId, "--keep-data"], configDir);
		status.installed = false;
	}
	if (!status.installed) await runClaudeOrThrow(["plugin", "install", mod.pluginId], configDir);
	else if (!status.enabled) await runClaudeOrThrow(["plugin", "enable", mod.pluginId], configDir);

	const after = await readDirStatus(mod, configDir);
	if (after?.version !== mod.pinnedVersion || !after.enabled) {
		throw new Error(`expected ${mod.pluginId} ${mod.pinnedVersion} enabled, found ${after?.version ?? "nothing"}`);
	}
}

async function applyClaudeMod(mod: ClaudeMod, enabled: boolean): Promise<void> {
	if (!(await readDirStatus(mod, undefined))) throw new Error("Claude Code CLI not found on PATH");
	for (const dir of claudeConfigDirs()) await applyInDir(mod, enabled, dir);
}

// One change at a time: two overlapping `claude plugin` runs race on the same
// installed_plugins.json and settings.json.
let inFlight: Promise<unknown> = Promise.resolve();

export function setClaudeModEnabled(modId: string, enabled: boolean): Promise<ClaudeModStatus> {
	const mod = findMod(modId);
	const run = inFlight.then(async () => {
		log.info("Applying Claude mod", { modId, enabled });
		await applyClaudeMod(mod, enabled);
		return getClaudeModStatus(modId);
	});
	inFlight = run.catch(() => {});
	return run;
}

export const claudeModsHandlers = {
	claudeModStatus: ({ modId }: { modId: string }) => getClaudeModStatus(modId),
	claudeModSetEnabled: ({ modId, enabled }: { modId: string; enabled: boolean }) => setClaudeModEnabled(modId, enabled),
};
