export const SIMPLIFY_VIEW_PRESET_IDS = [
	"agent-traffic", "stats-nav", "automations-tab", "keyboard-shortcut-editor",
	"custom-column-creation", "label-creation", "spawn-variant", "builtin:session.spawn-agent",
	"builtin:session.bug-hunters", "builtin:session.hibernate", "builtin:session.send-later", "builtin:session.pane-controls",
	"builtin:runtime.scripts", "builtin:runtime.dev-server-setup", "builtin:status.include-tests",
] as const;

/**
 * On-disk compatibility, not a code path: the names task-header controls had before they
 * became `taskHeader` registry ids. Read, they map to the registry id; written, they stay
 * next to it in `hiddenControls`, the field older installed versions read
 * (decisions/2026/11/21/task-header-user-layout.md).
 */
const LEGACY_HIDDEN_CONTROL_IDS: Readonly<Record<string, string>> = {
	"spawn-agent": "builtin:session.spawn-agent",
	"bug-hunters": "builtin:session.bug-hunters",
	hibernate: "builtin:session.hibernate",
	"scheduled-message": "builtin:session.send-later",
	"tmux-pane-controls": "builtin:session.pane-controls",
	"scripts-runner": "builtin:runtime.scripts",
	"setup-dev-server": "builtin:runtime.dev-server-setup",
	"diff-include-tests": "builtin:status.include-tests",
};

const LEGACY_ALIAS_OF = new Map(Object.entries(LEGACY_HIDDEN_CONTROL_IDS).map(([legacy, id]) => [id, legacy]));

function currentId(id: string): string {
	return LEGACY_HIDDEN_CONTROL_IDS[id] ?? id;
}

/** Both lists carry the aliases: a version that has `personalHiddenControls` rebuilds `hiddenControls` from it. */
function withLegacyAliases(ids: readonly string[]): string[] {
	return [...ids, ...ids.flatMap((id) => LEGACY_ALIAS_OF.get(id) ?? [])];
}

/** A stored legacy name, kept only for older installed versions. */
export function isLegacyHiddenControlAlias(id: string): boolean {
	return id in LEGACY_HIDDEN_CONTROL_IDS;
}

export interface SimplifiedInterfaceSettings {
	simplifiedMode?: boolean;
	personalHiddenControls?: string[];
	hiddenControls?: string[];
}

export function normalizeSimplifiedInterface(settings: SimplifiedInterfaceSettings) {
	const stored = (settings.hiddenControls ?? []).map(currentId);
	const personalHiddenControls = [...new Set((settings.personalHiddenControls ?? settings.hiddenControls ?? []).map(currentId))];
	const simplifiedMode = settings.simplifiedMode ?? SIMPLIFY_VIEW_PRESET_IDS.every((id) => stored.includes(id));
	const effective = [...new Set([...personalHiddenControls, ...(simplifiedMode ? SIMPLIFY_VIEW_PRESET_IDS : [])])];
	return {
		simplifiedMode,
		personalHiddenControls: withLegacyAliases(personalHiddenControls),
		hiddenControls: withLegacyAliases(effective),
	};
}

export function setSimplifiedInterfaceMode(settings: SimplifiedInterfaceSettings, enabled: boolean) {
	return normalizeSimplifiedInterface({ ...normalizeSimplifiedInterface(settings), simplifiedMode: enabled });
}
