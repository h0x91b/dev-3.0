import type { TranslationKey } from "./i18n/translations/en";

export interface Tip {
	id: string;
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	icon: string; // Nerd Font codepoint
}

const ALL_TIPS: Tip[] = [
	{
		id: "agent-create-tasks",
		titleKey: "tip.agentCreateTasks.title",
		bodyKey: "tip.agentCreateTasks.body",
		icon: "\u{F0219}", // nf-md-robot
	},
	{
		id: "agent-sees-tasks",
		titleKey: "tip.agentSeesTasks.title",
		bodyKey: "tip.agentSeesTasks.body",
		icon: "\u{F0EA0}", // nf-md-eye_outline
	},
	{
		id: "agent-notes",
		titleKey: "tip.agentNotes.title",
		bodyKey: "tip.agentNotes.body",
		icon: "\u{F09ED}", // nf-md-note_text_outline
	},
	{
		id: "drag-columns",
		titleKey: "tip.dragColumns.title",
		bodyKey: "tip.dragColumns.body",
		icon: "\u{F0453}", // nf-md-cursor_move
	},
	{
		id: "double-click-todo",
		titleKey: "tip.doubleClickTodo.title",
		bodyKey: "tip.doubleClickTodo.body",
		icon: "\u{F0A79}", // nf-md-lightning_bolt
	},
	{
		id: "right-click-open",
		titleKey: "tip.rightClickOpen.title",
		bodyKey: "tip.rightClickOpen.body",
		icon: "\u{F0379}", // nf-md-open_in_new
	},
	{
		id: "cmd-n-shortcut",
		titleKey: "tip.cmdN.title",
		bodyKey: "tip.cmdN.body",
		icon: "\u{F030C}", // nf-md-keyboard
	},
	{
		id: "terminal-preview",
		titleKey: "tip.terminalPreview.title",
		bodyKey: "tip.terminalPreview.body",
		icon: "\u{F0489}", // nf-md-monitor
	},
];

const STORAGE_KEY = "dev3-dismissed-tips";
const ROTATION_KEY = "dev3-tip-rotation-index";

function getDismissedIds(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? new Set(JSON.parse(raw)) : new Set();
	} catch {
		return new Set();
	}
}

export function dismissTip(tipId: string): void {
	const dismissed = getDismissedIds();
	dismissed.add(tipId);
	localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
}

export function getCurrentTip(): Tip | null {
	const dismissed = getDismissedIds();
	const available = ALL_TIPS.filter((t) => !dismissed.has(t.id));
	if (available.length === 0) return null;

	let index = 0;
	try {
		index = parseInt(localStorage.getItem(ROTATION_KEY) ?? "0", 10) || 0;
	} catch {
		// ignore
	}

	return available[index % available.length];
}

export function advanceTip(): void {
	const dismissed = getDismissedIds();
	const available = ALL_TIPS.filter((t) => !dismissed.has(t.id));
	if (available.length <= 1) return;

	let index = 0;
	try {
		index = parseInt(localStorage.getItem(ROTATION_KEY) ?? "0", 10) || 0;
	} catch {
		// ignore
	}

	localStorage.setItem(ROTATION_KEY, String((index + 1) % available.length));
}
