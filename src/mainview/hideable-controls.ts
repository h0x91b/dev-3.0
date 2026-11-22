// ── Hideable-control registry ──
// The stable ids a control can be hidden/restored by. The panel restore dropdown,
// the header kebab, and the Simplify View preset all read from here rather than
// each inventing their own list. See docs/ux/PRODUCT_UX_BIBLE.md §5.10.

/** Controls outside the task header, each hidden by its own fixed id. */
export type AppHideableControlId =
	// Global header (exactly these three — no new icon, restored via the kebab).
	| "agent-traffic"
	| "project-terminal-button"
	| "remote-access-qr"
	// Non-toolbar surfaces: no right-click affordance of their own, reachable
	// only through the Simplify View preset (apply / show all).
	| "stats-nav"
	| "automations-tab"
	| "keyboard-shortcut-editor"
	| "custom-column-creation"
	| "label-creation"
	| "spawn-variant";

/** Any task-header item: the id it is registered under in the `taskHeader` slot. */
export type TaskHeaderItemId = `${string}:${string}`;

export type HideableControlId = AppHideableControlId | TaskHeaderItemId;

/** Controls whose current hide/restore lives in the global header's kebab menu. */
export const HEADER_HIDEABLE_IDS: readonly HideableControlId[] = [
	"agent-traffic",
	"project-terminal-button",
	"remote-access-qr",
];

export { SIMPLIFY_VIEW_PRESET_IDS } from "../shared/simplified-interface";
