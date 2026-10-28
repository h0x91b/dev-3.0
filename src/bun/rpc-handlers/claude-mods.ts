import { CLAUDE_MODS, type ClaudeMod, type ClaudeModStatus } from "../../shared/types";
import { createLogger } from "../logger";
import { spawn } from "../spawn";

const log = createLogger("claude-mods");

/** Runs against the default Claude config dir: every managed account dir
 *  symlinks `plugins/` and `settings.json` back to it (CLAUDE_PRIVATE_ENTRIES),
 *  so one install reaches every account. */
async function runClaude(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = spawn(["claude", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function runClaudeOrThrow(args: string[]): Promise<string> {
	const { exitCode, stdout, stderr } = await runClaude(args);
	if (exitCode !== 0) {
		const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ");
		throw new Error(`claude ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}): ${detail}`);
	}
	return stdout;
}

async function readJsonList<T>(args: string[]): Promise<T[] | null> {
	try {
		const { exitCode, stdout } = await runClaude(args);
		if (exitCode !== 0) return null;
		const parsed = JSON.parse(stdout) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : null;
	} catch {
		return null;
	}
}

function findMod(modId: string): ClaudeMod {
	const mod = CLAUDE_MODS.find((m) => m.id === modId);
	if (!mod) throw new Error(`Unknown Claude mod: ${modId}`);
	return mod;
}

interface InstalledPlugin {
	id: string;
	version?: string;
	scope?: string;
	enabled?: boolean;
}

export async function getClaudeModStatus(modId: string): Promise<ClaudeModStatus> {
	const mod = findMod(modId);
	const plugins = await readJsonList<InstalledPlugin>(["plugin", "list", "--json"]);
	if (plugins === null) {
		return { modId, claudeAvailable: false, installed: false, enabled: false, version: null };
	}
	const entry = plugins.find((p) => p.id === mod.pluginId && (p.scope ?? "user") === "user");
	return {
		modId,
		claudeAvailable: true,
		installed: !!entry,
		enabled: entry?.enabled === true,
		version: entry?.version ?? null,
	};
}

async function ensureMarketplaceFresh(mod: ClaudeMod): Promise<void> {
	const marketplaces = (await readJsonList<{ name: string }>(["plugin", "marketplace", "list", "--json"])) ?? [];
	if (marketplaces.some((m) => m.name === mod.marketplace)) {
		await runClaudeOrThrow(["plugin", "marketplace", "update", mod.marketplace]);
	} else {
		await runClaudeOrThrow(["plugin", "marketplace", "add", mod.source]);
	}
}

/** On: refresh the marketplace and land on its latest version. Off: uninstall,
 *  keeping the plugin's data dir so a later re-enable restores the user's choices. */
async function applyClaudeMod(mod: ClaudeMod, enabled: boolean): Promise<void> {
	const before = await getClaudeModStatus(mod.id);
	if (!before.claudeAvailable) throw new Error("Claude Code CLI not found on PATH");

	if (!enabled) {
		if (before.installed) await runClaudeOrThrow(["plugin", "uninstall", mod.pluginId, "--keep-data"]);
		return;
	}

	await ensureMarketplaceFresh(mod);
	if (before.installed) {
		await runClaudeOrThrow(["plugin", "update", mod.pluginId]);
		if (!before.enabled) await runClaudeOrThrow(["plugin", "enable", mod.pluginId]);
	} else {
		await runClaudeOrThrow(["plugin", "install", mod.pluginId]);
	}
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
