export const SIMPLIFY_VIEW_PRESET_IDS = [
	"agent-traffic", "stats-nav", "automations-tab", "keyboard-shortcut-editor",
	"custom-column-creation", "label-creation", "spawn-variant", "spawn-agent",
	"bug-hunters", "hibernate", "scheduled-message", "tmux-pane-controls",
	"scripts-runner", "setup-dev-server", "diff-include-tests",
] as const;

export interface SimplifiedInterfaceSettings {
	simplifiedMode?: boolean;
	personalHiddenControls?: string[];
	hiddenControls?: string[];
}

export function normalizeSimplifiedInterface(settings: SimplifiedInterfaceSettings) {
	const personalHiddenControls = [...new Set(settings.personalHiddenControls ?? settings.hiddenControls ?? [])];
	const simplifiedMode = settings.simplifiedMode ?? SIMPLIFY_VIEW_PRESET_IDS.every((id) => (settings.hiddenControls ?? []).includes(id));
	return {
		simplifiedMode,
		personalHiddenControls,
		hiddenControls: [...new Set([...personalHiddenControls, ...(simplifiedMode ? SIMPLIFY_VIEW_PRESET_IDS : [])])],
	};
}

export function setSimplifiedInterfaceMode(settings: SimplifiedInterfaceSettings, enabled: boolean) {
	return normalizeSimplifiedInterface({ ...normalizeSimplifiedInterface(settings), simplifiedMode: enabled });
}
