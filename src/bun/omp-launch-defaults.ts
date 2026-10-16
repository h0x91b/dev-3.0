/**
 * Settings dev3 picks for omp when the user has not picked them. omp layers a
 * `--config` overlay ABOVE the user's own config.yml, so the overlay is passed
 * only when no layer the user controls already sets the key.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDev3Home } from "../shared/dev3-home";
import { quoteIfUnsafe } from "../shared/agent-adapters/shell";

/** dev3's terminal always has a Nerd Font in its stack (`DEFAULT_TERMINAL_FONT_STACK`),
 *  so omp's icon set renders there; its own default (`unicode`) looks broken next to it. */
export const OMP_LAUNCH_DEFAULTS: Readonly<Record<string, string>> = { symbolPreset: "nerd" };

const CONFIG_FILENAMES = ["config.yml", "config.yaml"];

function setsTopLevelKey(dir: string, key: string): boolean {
	const pattern = new RegExp(`^${key}\\s*:`, "m");
	for (const name of CONFIG_FILENAMES) {
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		try {
			if (pattern.test(readFileSync(path, "utf-8"))) return true;
		} catch {
			// Unreadable means unknown — treat it as set rather than override the user.
			return true;
		}
	}
	return false;
}

/** The defaults no user-controlled layer sets: the agent dir's config.yml (an
 *  account dir links the user's own) and the worktree's `.omp/config.yml`. */
export function missingOmpDefaults(agentDir: string, worktreePath?: string): Record<string, string> {
	const dirs = [agentDir, ...(worktreePath ? [join(worktreePath, ".omp")] : [])];
	return Object.fromEntries(
		Object.entries(OMP_LAUNCH_DEFAULTS).filter(([key]) => !dirs.some((dir) => setsTopLevelKey(dir, key))),
	);
}

export function ompDefaultsOverlayPath(dev3Home: string = resolveDev3Home()): string {
	return join(dev3Home, "data", "agent-hooks", "omp-defaults.yml");
}

function writeOverlay(values: Record<string, string>, dev3Home?: string): string {
	const path = ompDefaultsOverlayPath(dev3Home);
	const body = Object.entries(values).map(([key, value]) => `${key}: ${value}\n`).join("");
	mkdirSync(join(path, ".."), { recursive: true });
	if (existsSync(path) && readFileSync(path, "utf-8") === body) return path;
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, body, "utf-8");
		renameSync(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
		throw err;
	}
	return path;
}

/** `["--config", <overlay>]` carrying the defaults the user left unset, or `[]`. */
export function ompDefaultsArgs(options: { agentDir?: string; worktreePath?: string; dev3Home?: string } = {}): string[] {
	const agentDir = options.agentDir || join(homedir(), ".omp", "agent");
	const missing = missingOmpDefaults(agentDir, options.worktreePath);
	if (Object.keys(missing).length === 0) return [];
	return ["--config", quoteIfUnsafe(writeOverlay(missing, options.dev3Home))];
}
