import type { TranslationKey } from "./i18n";
import type { GlobalSettings } from "../shared/types";

/** The seven durable-configuration categories shown by Global Settings. */
export const SETTINGS_CATEGORIES = [
	{
		id: "appearance",
		labelKey: "settings.categoryAppearance",
		descriptionKey: "settings.categoryAppearanceDesc",
	},
	{
		id: "tasks",
		labelKey: "settings.categoryTasks",
		descriptionKey: "settings.categoryTasksDesc",
	},
	{
		id: "terminal",
		labelKey: "settings.categoryTerminal",
		descriptionKey: "settings.categoryTerminalDesc",
	},
	{
		id: "agents",
		labelKey: "settings.categoryAgents",
		descriptionKey: "settings.categoryAgentsDesc",
	},
	{
		id: "accounts",
		labelKey: "settings.categoryAccounts",
		descriptionKey: "settings.categoryAccountsDesc",
	},
	{
		id: "workspace",
		labelKey: "settings.categoryWorkspace",
		descriptionKey: "settings.categoryWorkspaceDesc",
	},
	{
		id: "system",
		labelKey: "settings.categorySystem",
		descriptionKey: "settings.categorySystemDesc",
	},
] as const satisfies readonly SettingsCategoryDefinition[];

type SettingsCategoryDefinition = {
	readonly id: string;
	readonly labelKey: TranslationKey;
	readonly descriptionKey: TranslationKey;
};

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

/**
 * Legacy route/event ids kept for callers that predate the category layout.
 * The map below is the one vocabulary boundary for those deep links.
 */
export type LegacySettingsSectionId =
	| "appearance"
	| "behavior"
	| "workspace"
	| "agents"
	| "proxy"
	| "developer";

export type SettingsRouteSectionId = SettingsCategoryId | LegacySettingsSectionId;

export const LEGACY_SETTINGS_CATEGORY_MAP: Record<
	LegacySettingsSectionId,
	SettingsCategoryId
> = {
	appearance: "appearance",
	behavior: "tasks",
	workspace: "workspace",
	agents: "agents",
	proxy: "system",
	developer: "system",
};

export type SettingsEntry = {
	readonly id: string;
	readonly category: SettingsCategoryId;
	readonly titleKey: TranslationKey;
	readonly descriptionKey: TranslationKey;
	readonly anchor?: string;
	readonly globalField?: keyof GlobalSettings;
	readonly storage: "global" | "local" | "browser" | "surface";
};

/**
 * Registry metadata only: controls remain bespoke components, while this list
 * owns their searchable copy, category, and scroll anchor.
 */
export const SETTINGS_ENTRIES = [
	{
		id: "theme",
		category: "appearance",
		titleKey: "settings.theme",
		descriptionKey: "settings.themeDesc",
		anchor: "theme",
		globalField: "theme",
		storage: "local",
	},
	{
		id: "language",
		category: "appearance",
		titleKey: "settings.language",
		descriptionKey: "settings.languageDesc",
		anchor: "language",
		storage: "local",
	},
	{
		id: "zoom",
		category: "appearance",
		titleKey: "settings.zoom",
		descriptionKey: "settings.zoomDesc",
		anchor: "zoom",
		storage: "local",
	},
	{
		id: "task-drop-position",
		category: "tasks",
		titleKey: "settings.taskDropPosition",
		descriptionKey: "settings.taskDropPositionDesc",
		anchor: "task-drop-position",
		globalField: "taskDropPosition",
		storage: "global",
	},
	{
		id: "task-open-mode",
		category: "tasks",
		titleKey: "settings.taskOpenMode",
		descriptionKey: "settings.taskOpenModeDesc",
		anchor: "task-open-mode",
		globalField: "taskOpenMode",
		storage: "global",
	},
	{
		id: "default-diff-view",
		category: "tasks",
		titleKey: "settings.defaultDiffViewMode",
		descriptionKey: "settings.defaultDiffViewModeDesc",
		anchor: "default-diff-view",
		globalField: "defaultDiffViewMode",
		storage: "global",
	},
	{
		id: "watch-by-default",
		category: "tasks",
		titleKey: "settings.watchByDefault",
		descriptionKey: "settings.watchByDefaultDesc",
		anchor: "watch-by-default",
		globalField: "watchByDefault",
		storage: "global",
	},
	{
		id: "task-complete-sound",
		category: "tasks",
		titleKey: "settings.taskCompleteSound",
		descriptionKey: "settings.taskCompleteSoundDesc",
		anchor: "task-complete-sound",
		globalField: "playSoundOnTaskComplete",
		storage: "global",
	},
	{
		id: "focus-mode",
		category: "tasks",
		titleKey: "settings.focusMode",
		descriptionKey: "settings.focusModeDesc",
		anchor: "focus-mode",
		globalField: "focusMode",
		storage: "global",
	},
	{
		id: "tips",
		category: "tasks",
		titleKey: "settings.tipsSection",
		descriptionKey: "settings.tipsDesc",
		anchor: "tips",
		globalField: "tipsDisabled",
		storage: "global",
	},
	{
		id: "auto-open-images",
		category: "tasks",
		titleKey: "settings.autoOpenImages",
		descriptionKey: "settings.autoOpenImagesDesc",
		anchor: "auto-open-images",
		storage: "local",
	},
	{
		id: "terminal-keymap",
		category: "terminal",
		titleKey: "settings.terminalKeymap",
		descriptionKey: "settings.terminalKeymapDesc",
		anchor: "terminal-keymap",
		globalField: "terminalKeymap",
		storage: "global",
	},
	{
		id: "terminal-scroll-speed",
		category: "terminal",
		titleKey: "settings.scrollSpeed",
		descriptionKey: "settings.scrollSpeedDesc",
		anchor: "terminal-scroll-speed",
		storage: "local",
	},
	{
		id: "default-agent",
		category: "agents",
		titleKey: "settings.defaultAgent",
		descriptionKey: "settings.defaultAgentDesc",
		anchor: "default-agent",
		globalField: "defaultAgentId",
		storage: "global",
	},
	{
		id: "default-config",
		category: "agents",
		titleKey: "settings.defaultConfig",
		descriptionKey: "settings.defaultConfigDesc",
		anchor: "default-agent",
		globalField: "defaultConfigId",
		storage: "global",
	},
	{
		id: "agents-editor",
		category: "agents",
		titleKey: "settings.agents",
		descriptionKey: "settings.agentsDesc",
		anchor: "agents-editor",
		storage: "surface",
	},
	{
		id: "rate-limit-tracking",
		category: "agents",
		titleKey: "settings.rateLimitTracking",
		descriptionKey: "settings.rateLimitTrackingDesc",
		anchor: "rate-limit-tracking",
		globalField: "agentRateLimitTracking",
		storage: "global",
	},
	{
		id: "agent-accounts",
		category: "accounts",
		titleKey: "settings.agentAccounts",
		descriptionKey: "settings.agentAccountsDesc",
		anchor: "agent-accounts",
		storage: "surface",
	},
	{
		id: "api-profiles",
		category: "accounts",
		titleKey: "settings.accountsAddApi",
		descriptionKey: "settings.accountsApiProfilesDesc",
		anchor: "agent-accounts",
		storage: "surface",
	},
	{
		id: "clone-directory",
		category: "workspace",
		titleKey: "settings.cloneBaseDir",
		descriptionKey: "settings.cloneBaseDirDesc",
		anchor: "clone-directory",
		globalField: "cloneBaseDirectory",
		storage: "global",
	},
	{
		id: "external-apps",
		category: "workspace",
		titleKey: "settings.externalApps",
		descriptionKey: "settings.externalAppsDesc",
		anchor: "external-apps",
		globalField: "externalApps",
		storage: "global",
	},
	{
		id: "update-channel",
		category: "system",
		titleKey: "settings.updateChannel",
		descriptionKey: "settings.updateChannelDesc",
		anchor: "update-channel",
		globalField: "updateChannel",
		storage: "global",
	},
	{
		id: "prevent-sleep",
		category: "system",
		titleKey: "settings.preventSleep",
		descriptionKey: "settings.preventSleepDesc",
		anchor: "prevent-sleep",
		globalField: "preventSleepWhileRunning",
		storage: "global",
	},
	{
		id: "confirm-before-quit",
		category: "system",
		titleKey: "settings.confirmBeforeQuit",
		descriptionKey: "settings.confirmBeforeQuitDesc",
		anchor: "confirm-before-quit",
		globalField: "skipQuitDialog",
		storage: "global",
	},
	{
		id: "browser-notifications",
		category: "system",
		titleKey: "settings.browserNotifications",
		descriptionKey: "settings.browserNotificationsDesc",
		anchor: "browser-notifications",
		storage: "browser",
	},
	{
		id: "token-saving-proxy",
		category: "system",
		titleKey: "settings.pxpipeSection",
		descriptionKey: "settings.pxpipeSectionDesc",
		anchor: "token-saving-proxy",
		globalField: "pxpipeProxyEnabled",
		storage: "global",
	},
	{
		id: "developer-tools",
		category: "system",
		titleKey: "settings.devTools",
		descriptionKey: "settings.devToolsDesc",
		anchor: "developer-tools",
		storage: "surface",
	},
] as const satisfies readonly SettingsEntry[];

/** GlobalSettings fields intentionally kept outside the visible settings registry. */
export const SETTINGS_GLOBAL_FIELD_EXCLUSIONS = [
	"resolvedTheme",
	"customBinaryPaths",
	"agentBinaryPaths",
	"importShellEnv",
	"agentsLayoutRevision",
	"favorites",
] as const satisfies readonly (keyof GlobalSettings)[];

/** Runtime list used by the registry integrity test; the type check catches schema drift. */
export const GLOBAL_SETTINGS_FIELDS = [
	"defaultAgentId",
	"defaultConfigId",
	"taskDropPosition",
	"updateChannel",
	"theme",
	"resolvedTheme",
	"cloneBaseDirectory",
	"customBinaryPaths",
	"agentBinaryPaths",
	"terminalKeymap",
	"playSoundOnTaskComplete",
	"externalApps",
	"tipsDisabled",
	"taskOpenMode",
	"defaultDiffViewMode",
	"preventSleepWhileRunning",
	"skipQuitDialog",
	"importShellEnv",
	"focusMode",
	"agentRateLimitTracking",
	"watchByDefault",
	"agentsLayoutRevision",
	"pxpipeProxyEnabled",
	"favorites",
] as const satisfies readonly (keyof GlobalSettings)[];

type RegisteredGlobalSettingsField = (typeof SETTINGS_ENTRIES)[number] extends infer Entry
	? Entry extends { readonly globalField?: infer Field }
		? Extract<Field, keyof GlobalSettings>
		: never
	: never;
type ExcludedGlobalSettingsField = (typeof SETTINGS_GLOBAL_FIELD_EXCLUSIONS)[number];
type MissingGlobalSettingsField = Exclude<
	keyof GlobalSettings,
	RegisteredGlobalSettingsField | ExcludedGlobalSettingsField
>;
type UnlistedGlobalSettingsField = Exclude<
	keyof GlobalSettings,
	(typeof GLOBAL_SETTINGS_FIELDS)[number]
>;

/** Compile-time guards: adding a GlobalSettings field requires registry disposition. */
export const SETTINGS_REGISTRY_INTEGRITY: Record<MissingGlobalSettingsField, never> = {};
export const GLOBAL_SETTINGS_FIELDS_INTEGRITY: Record<UnlistedGlobalSettingsField, never> = {};

export function isSettingsCategoryId(value: string): value is SettingsCategoryId {
	return SETTINGS_CATEGORIES.some((category) => category.id === value);
}

/** Resolve a route/event section to the current category vocabulary. */
export function normalizeSettingsCategoryId(
	section?: SettingsRouteSectionId,
): SettingsCategoryId {
	if (!section) return SETTINGS_CATEGORIES[0].id;
	return (
		LEGACY_SETTINGS_CATEGORY_MAP[section as LegacySettingsSectionId] ??
		(isSettingsCategoryId(section) ? section : SETTINGS_CATEGORIES[0].id)
	);
}

export function filterSettingsEntries(
	query: string,
	localizedText: (key: TranslationKey) => string,
): readonly SettingsEntry[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return SETTINGS_ENTRIES;
	return SETTINGS_ENTRIES.filter((entry) => {
		const haystack = `${localizedText(entry.titleKey)} ${localizedText(entry.descriptionKey)}`
			.toLocaleLowerCase();
		return haystack.includes(normalized);
	});
}

export function groupSettingsEntriesByCategory(
	entries: readonly SettingsEntry[],
) {
	return SETTINGS_CATEGORIES.map((category) => ({
		category,
		entries: entries.filter((entry) => entry.category === category.id),
	})).filter((group) => group.entries.length > 0);
}
