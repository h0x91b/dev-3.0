import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { GlobalSettings, ShortcutOverride } from "../shared/types";
import { DEFAULT_AGENTS, DEPRECATED_DEFAULT_CONFIG_REMAP } from "../shared/types";
import { recordFavoriteUsage, sanitizeFavorites } from "../shared/favorites";
import { coerceUpdateChannel, DEFAULT_UPDATE_CHANNEL } from "../shared/update-channel";
import { canaryPublishesFor, hostOsName } from "../shared/canary-publish";

/**
 * Does the canary feed carry a build for THIS machine? Asked here rather than passed in,
 * because only the host knows its own platform — the renderer would answer for the browser.
 */
export function hostPublishesCanary(): boolean {
	return canaryPublishesFor(hostOsName(process.platform), process.arch);
}
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

/**
 * Keep only well-shaped shortcut rebinds. The renderer owns the combo grammar
 * (`src/mainview/keymap-bindings.ts`) and drops entries it cannot parse, so this
 * side only guards the container: a garbled settings.json must not take the
 * whole keymap with it. An empty array is kept — it means "deliberately unbound".
 */
/**
 * Keyboard overrides, slot by slot. A slot is kept only when it is a string (a
 * serialized combo) or `null` (deliberately unbound) — anything else is dropped
 * rather than allowed to corrupt the keymap. Written by the renderer, so treat it
 * as untrusted shape.
 */
function sanitizeShortcutOverrides(raw: unknown): GlobalSettings["keyboardShortcuts"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, ShortcutOverride> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const slots = value as Record<string, unknown>;
		const kept: ShortcutOverride = {};
		for (const slot of ["primary", "alias"] as const) {
			if (!(slot in slots)) continue;
			const entry = slots[slot];
			if (typeof entry === "string") kept[slot] = entry;
			else if (entry === null) kept[slot] = null;
		}
		if (Object.keys(kept).length > 0) out[id] = kept;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const DEFAULT_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto-opus5-medium",
	taskSortOrder: "oldest-first",
	updateChannel: DEFAULT_UPDATE_CHANNEL,
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

/**
 * Shape the raw file into `GlobalSettings`.
 *
 * One function for both loaders on purpose: they used to be hand-kept twins, and
 * the sync one silently lacked `analyticsDistinctId` — so the value existed on
 * disk, the async reader saw it, and every synchronous reader got `undefined`.
 */
function normalizeSettings(data: Record<string, unknown>): GlobalSettings {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const d = data as any;
	return {
		defaultAgentId: d.defaultAgentId ?? DEFAULT_SETTINGS.defaultAgentId,
		defaultConfigId: resolveDefaultConfigId(d.defaultConfigId),
		taskSortOrder: d.taskSortOrder === "newest-first" ? "newest-first" : "oldest-first",
		updateChannel: coerceUpdateChannel(d.updateChannel, hostPublishesCanary()),
		theme: d.theme === "light" || d.theme === "system" || d.theme === "dark" ? d.theme : undefined,
		resolvedTheme: d.resolvedTheme === "light" || d.resolvedTheme === "dark" ? d.resolvedTheme : undefined,
		// Machine identity for analytics — opaque string, never regenerated on load.
		analyticsDistinctId: typeof d.analyticsDistinctId === "string" && d.analyticsDistinctId
			? d.analyticsDistinctId
			: undefined,
		cloneBaseDirectory: d.cloneBaseDirectory ?? undefined,
		customBinaryPaths: d.customBinaryPaths ?? undefined,
		agentBinaryPaths: d.agentBinaryPaths ?? undefined,
		playSoundOnTaskComplete: d.playSoundOnTaskComplete ?? true,
		externalApps: Array.isArray(d.externalApps) ? d.externalApps : undefined,
		tipsDisabled: d.tipsDisabled === true ? true : undefined,
		taskOpenMode: d.taskOpenMode === "fullscreen" ? "fullscreen" : undefined,
		terminalPathOpenMode:
			d.terminalPathOpenMode === "preview" ||
			d.terminalPathOpenMode === "system" ||
			d.terminalPathOpenMode === "reveal"
				? d.terminalPathOpenMode
				: undefined,
		defaultDiffViewMode:
			d.defaultDiffViewMode === "unified"
				? "unified"
				: d.defaultDiffViewMode === "split"
					? "split"
					: d.defaultDiffViewMode === "auto"
						? "auto"
						: undefined,
		preventSleepWhileRunning: d.preventSleepWhileRunning ?? undefined,
		skipQuitDialog: d.skipQuitDialog === true ? true : undefined,
		importShellEnv: d.importShellEnv === false ? false : undefined,
		focusMode: d.focusMode === true ? true : undefined,
		// Default-on toggle — only an explicit false is a stored opt-out.
		agentRateLimitTracking: d.agentRateLimitTracking === false ? false : undefined,
		// Boolean preference — both true (watch) and false (don't watch) are
		// meaningful stored choices, so preserve either; only undefined drops.
		watchByDefault: typeof d.watchByDefault === "boolean" ? d.watchByDefault : undefined,
		// Default-on toggle — only an explicit false is a stored opt-out.
		suggestCompletingTasksAfterMerge: d.suggestCompletingTasksAfterMerge === false ? false : undefined,
		agentsLayoutRevision: typeof d.agentsLayoutRevision === "number" ? d.agentsLayoutRevision : undefined,
		// Default-off experimental toggle — only an explicit true is a stored opt-in.
		pxpipeProxyEnabled: d.pxpipeProxyEnabled === true ? true : undefined,
		// Default-off beta toggle — only an explicit true is a stored opt-in.
		experimentalTerminalBidi: d.experimentalTerminalBidi === true ? true : undefined,
		// Cross-provider favorite pointers; shape-validated, capped, empty ⇒ undefined.
		favorites: sanitizeFavorites(d.favorites),
		// User shortcut rebinds; sparse by design — absent means "all defaults".
		keyboardShortcuts: sanitizeShortcutOverrides(d.keyboardShortcuts),
		// Custom Review-toggle prompt; blank ⇒ the localized built-in text.
		reviewModePrompt: typeof d.reviewModePrompt === "string" && d.reviewModePrompt.trim()
			? d.reviewModePrompt
			: undefined,
	};
}

export async function loadSettings(): Promise<GlobalSettings> {
	try {
		const file = Bun.file(SETTINGS_FILE);
		if (!(await file.exists())) return { ...DEFAULT_SETTINGS };
		return normalizeSettings(await file.json());
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

/**
 * Best-effort: bump `uses`/`lastUsedAt` for each launched (agentId, configId)
 * that is already a favorite (once per spawned agent). Loads → applies → saves
 * only when something changed; null halves and non-favorite pairs are ignored.
 * Never throws — a failed counter update must not break a launch. Load-modify-save
 * is not fully atomic (a rare concurrent settings write could drop an increment),
 * which is acceptable for a best-effort usage counter.
 */
export async function recordFavoriteUsages(
	pairs: Array<{ agentId: string | null | undefined; configId: string | null | undefined }>,
): Promise<void> {
	try {
		const clean = pairs.filter(
			(p): p is { agentId: string; configId: string } => !!p.agentId && !!p.configId,
		);
		if (clean.length === 0) return;
		const settings = await loadSettings();
		let favorites = settings.favorites ?? [];
		if (favorites.length === 0) return;
		const now = Date.now();
		let changed = false;
		for (const { agentId, configId } of clean) {
			const next = recordFavoriteUsage(favorites, agentId, configId, now);
			if (next !== favorites) {
				favorites = next;
				changed = true;
			}
		}
		if (changed) await saveSettings({ ...settings, favorites });
	} catch (err) {
		log.error("Failed to record favorite usage", { error: String(err) });
	}
}

export function loadSettingsSync(): GlobalSettings {
	try {
		if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
		return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")));
	} catch (err) {
		log.error("Failed to load settings (sync)", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}
