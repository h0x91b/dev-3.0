import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { GlobalSettings } from "../shared/types";
import { DEFAULT_AGENTS, DEPRECATED_DEFAULT_CONFIG_REMAP } from "../shared/types";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("settings");

const SETTINGS_FILE = `${DEV3_HOME}/settings.json`;

// `GlobalSettings` has a single source of truth in `src/shared/types.ts` (it is
// the RPC schema type shared with the renderer). Re-export it here so this
// module's consumers can keep importing it from "./settings", but never define
// a second copy — a drifted local interface is what silently dropped
// `tipsDisabled` on load and then erased it from disk on the next save.
export type { GlobalSettings };

const DEFAULT_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto-opus48-xhigh",
	taskDropPosition: "top",
	updateChannel: "stable",
};

const ALL_BUILTIN_CONFIG_IDS = new Set(DEFAULT_AGENTS.flatMap((a) => a.configurations.map((c) => c.id)));
// Derived (not hardcoded) so this stays correct if a builtin agent's id prefix ever changes.
const BUILTIN_ID_PREFIXES = Array.from(
	new Set(DEFAULT_AGENTS.flatMap((a) => a.configurations.map((c) => `${c.id.split("-")[0]}-`))),
);

/** Remaps a stored `defaultConfigId` that no longer exists (preset removed/renamed
 *  in DEFAULT_AGENTS) to its closest surviving equivalent. If it's still not a
 *  known builtin id after that (e.g. we removed a preset and forgot to add a
 *  remap entry above), falls back to our current default rather than leaving
 *  "Launch Task" with a dangling reference and no selection. Ids that don't
 *  look like one of our builtin prefixes are assumed to be genuine
 *  user-created custom configs and are left untouched. */
function resolveDefaultConfigId(stored: unknown): string {
	if (typeof stored !== "string" || !stored) return DEFAULT_SETTINGS.defaultConfigId;
	const remapped = DEPRECATED_DEFAULT_CONFIG_REMAP[stored] ?? stored;
	if (ALL_BUILTIN_CONFIG_IDS.has(remapped)) return remapped;
	const looksBuiltin = BUILTIN_ID_PREFIXES.some((prefix) => remapped.startsWith(prefix));
	return looksBuiltin ? DEFAULT_SETTINGS.defaultConfigId : remapped;
}

export async function loadSettings(): Promise<GlobalSettings> {
	try {
		const file = Bun.file(SETTINGS_FILE);
		if (!(await file.exists())) {
			return { ...DEFAULT_SETTINGS };
		}
		const data = await file.json();
		return {
			defaultAgentId: data.defaultAgentId ?? DEFAULT_SETTINGS.defaultAgentId,
			defaultConfigId: resolveDefaultConfigId(data.defaultConfigId),
			taskDropPosition: data.taskDropPosition === "bottom" ? "bottom" : "top",
			updateChannel: data.updateChannel === "canary" ? "canary" : "stable",
			theme: data.theme === "light" || data.theme === "system" || data.theme === "dark" ? data.theme : undefined,
			resolvedTheme: data.resolvedTheme === "light" || data.resolvedTheme === "dark" ? data.resolvedTheme : undefined,
			cloneBaseDirectory: data.cloneBaseDirectory ?? undefined,
			customBinaryPaths: data.customBinaryPaths ?? undefined,
			agentBinaryPaths: data.agentBinaryPaths ?? undefined,
			playSoundOnTaskComplete: data.playSoundOnTaskComplete ?? true,
			externalApps: Array.isArray(data.externalApps) ? data.externalApps : undefined,
			// iTerm2 is the default (undefined ⇒ iterm2 in the renderer), so an
			// explicit "default" is a real opt-out that must survive a round-trip;
			// collapsing it to undefined would silently re-enable the hotkeys.
			terminalKeymap:
				data.terminalKeymap === "iterm2"
					? "iterm2"
					: data.terminalKeymap === "default"
						? "default"
						: undefined,
			tipsDisabled: data.tipsDisabled === true ? true : undefined,
			taskOpenMode: data.taskOpenMode === "fullscreen" ? "fullscreen" : undefined,
			defaultDiffViewMode:
				data.defaultDiffViewMode === "unified"
					? "unified"
					: data.defaultDiffViewMode === "split"
						? "split"
						: data.defaultDiffViewMode === "auto"
							? "auto"
							: undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
			skipQuitDialog: data.skipQuitDialog === true ? true : undefined,
			importShellEnv: data.importShellEnv === false ? false : undefined,
			focusMode: data.focusMode === true ? true : undefined,
			// Default-on toggle — only an explicit false is a stored opt-out.
			agentRateLimitTracking: data.agentRateLimitTracking === false ? false : undefined,
			// Boolean preference — both true (watch) and false (don't watch) are
			// meaningful stored choices, so preserve either; only undefined drops.
			watchByDefault: typeof data.watchByDefault === "boolean" ? data.watchByDefault : undefined,
			agentsLayoutRevision: typeof data.agentsLayoutRevision === "number" ? data.agentsLayoutRevision : undefined,
			// Default-off experimental toggle — only an explicit true is a stored opt-in.
			pxpipeProxyEnabled: data.pxpipeProxyEnabled === true ? true : undefined,
		};
	} catch (err) {
		log.error("Failed to load settings", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}


export async function saveSettings(settings: GlobalSettings): Promise<void> {
	log.info("Saving global settings", { settings });
	await withFileLock(SETTINGS_FILE, async () => {
		mkdirSync(DEV3_HOME, { recursive: true });
		const tempFile = `${SETTINGS_FILE}.tmp`;
		await Bun.write(tempFile, JSON.stringify(settings, null, 2));
		renameSync(tempFile, SETTINGS_FILE);
	});
	log.info("Global settings saved");
}

export function loadSettingsSync(): GlobalSettings {
	try {
		if (!existsSync(SETTINGS_FILE)) {
			return { ...DEFAULT_SETTINGS };
		}
		const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		return {
			defaultAgentId: data.defaultAgentId ?? DEFAULT_SETTINGS.defaultAgentId,
			defaultConfigId: resolveDefaultConfigId(data.defaultConfigId),
			taskDropPosition: data.taskDropPosition === "bottom" ? "bottom" : "top",
			updateChannel: data.updateChannel === "canary" ? "canary" : "stable",
			theme: data.theme === "light" || data.theme === "system" || data.theme === "dark" ? data.theme : undefined,
			resolvedTheme: data.resolvedTheme === "light" || data.resolvedTheme === "dark" ? data.resolvedTheme : undefined,
			cloneBaseDirectory: data.cloneBaseDirectory ?? undefined,
			customBinaryPaths: data.customBinaryPaths ?? undefined,
			agentBinaryPaths: data.agentBinaryPaths ?? undefined,
			playSoundOnTaskComplete: data.playSoundOnTaskComplete ?? true,
			externalApps: Array.isArray(data.externalApps) ? data.externalApps : undefined,
			// iTerm2 is the default (undefined ⇒ iterm2 in the renderer), so an
			// explicit "default" is a real opt-out that must survive a round-trip;
			// collapsing it to undefined would silently re-enable the hotkeys.
			terminalKeymap:
				data.terminalKeymap === "iterm2"
					? "iterm2"
					: data.terminalKeymap === "default"
						? "default"
						: undefined,
			tipsDisabled: data.tipsDisabled === true ? true : undefined,
			taskOpenMode: data.taskOpenMode === "fullscreen" ? "fullscreen" : undefined,
			defaultDiffViewMode:
				data.defaultDiffViewMode === "unified"
					? "unified"
					: data.defaultDiffViewMode === "split"
						? "split"
						: data.defaultDiffViewMode === "auto"
							? "auto"
							: undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
			skipQuitDialog: data.skipQuitDialog === true ? true : undefined,
			importShellEnv: data.importShellEnv === false ? false : undefined,
			focusMode: data.focusMode === true ? true : undefined,
			// Default-on toggle — only an explicit false is a stored opt-out.
			agentRateLimitTracking: data.agentRateLimitTracking === false ? false : undefined,
			// Boolean preference — both true (watch) and false (don't watch) are
			// meaningful stored choices, so preserve either; only undefined drops.
			watchByDefault: typeof data.watchByDefault === "boolean" ? data.watchByDefault : undefined,
			agentsLayoutRevision: typeof data.agentsLayoutRevision === "number" ? data.agentsLayoutRevision : undefined,
			// Default-off experimental toggle — only an explicit true is a stored opt-in.
			pxpipeProxyEnabled: data.pxpipeProxyEnabled === true ? true : undefined,
		};
	} catch (err) {
		log.error("Failed to load settings (sync)", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}
