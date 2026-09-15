// ── Hideable-control registry ──
// The stable ids a control can be hidden/restored by. This is the one place
// that knows what can be hidden — the panel restore dropdown, the header
// kebab, and the Simplify View preset all read from here rather than each
// inventing their own list. See docs/ux/PRODUCT_UX_BIBLE.md §5.10.

export type HideableControlId =
	// Global header (exactly these three — no new icon, restored via the kebab).
	| "agent-traffic"
	| "project-terminal-button"
	| "remote-access-qr"
	// Task info panel — Session/Agent bar.
	| "spawn-agent"
	| "bug-hunters"
	| "hibernate"
	| "scheduled-message"
	| "tmux-pane-controls"
	// Task info panel — Runtime & access bar.
	| "scripts-runner"
	| "setup-dev-server"
	// Task info panel — Context bar.
	| "diff-include-tests"
	// Non-toolbar surfaces: no right-click affordance of their own, reachable
	// only through the Simplify View preset (apply / show all).
	| "stats-nav"
	| "automations-tab"
	| "keyboard-shortcut-editor"
	| "custom-column-creation"
	| "label-creation"
	| "spawn-variant";

/** Which task-info-panel bar a hideable control belongs to, for the restore dropdown's grouping. */
export const PANEL_BAR_OF_CONTROL: Partial<Record<HideableControlId, "context" | "session-agent" | "runtime">> = {
	"diff-include-tests": "context",
	"spawn-agent": "session-agent",
	"bug-hunters": "session-agent",
	hibernate: "session-agent",
	"scheduled-message": "session-agent",
	"tmux-pane-controls": "session-agent",
	"scripts-runner": "runtime",
	"setup-dev-server": "runtime",
};

/** Controls whose current hide/restore lives in the global header's kebab menu. */
export const HEADER_HIDEABLE_IDS: readonly HideableControlId[] = [
	"agent-traffic",
	"project-terminal-button",
	"remote-access-qr",
];

/**
 * Simplify View is a named preset, not a separate flag: turning it on writes
 * these ids into the hidden set, exactly as if the user had hidden each by
 * hand. A control absent from this list is never touched by the preset and
 * stays visible by default, even with Simplify View applied — that is how a
 * new feature announces itself instead of appearing pre-hidden for everyone.
 */
export const SIMPLIFY_VIEW_PRESET_IDS: readonly HideableControlId[] = [
	"agent-traffic",
	"stats-nav",
	"automations-tab",
	"keyboard-shortcut-editor",
	"custom-column-creation",
	"label-creation",
	"spawn-variant",
	"spawn-agent",
	"bug-hunters",
	"hibernate",
	"scheduled-message",
	"tmux-pane-controls",
	"scripts-runner",
	"setup-dev-server",
	"diff-include-tests",
];
