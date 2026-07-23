import { DEFAULT_EXTERNAL_APPS } from "../../shared/types";

/** Nerd Font glyphs for known external-app ids, shared by the "Open in…" surfaces. */
export const OPEN_IN_APP_ICONS: Record<string, string> = {
	finder: "\u{F024}", // nf-oct-file_directory
	vscode: "\u{F0A1E}", // nf-md-microsoft_visual_studio_code
	cursor: "\u{F0A1E}", // reuse vscode icon
	ghostty: "\u{F489}", // nf-oct-terminal
	iterm: "\u{F489}",
	terminal: "\u{F489}",
	intellij: "\u{F0184}", // nf-md-diamond_stone (IntelliJ)
	"intellij-ultimate": "\u{F0184}",
	"intellij-ce": "\u{F0184}",
	pycharm: "\u{F0184}",
	zed: "\u{F0599}", // nf-md-lightning_bolt (Zed)
	sublime: "\u{F0CC5}", // nf-md-text_box (Sublime Text)
};

/** Fallback glyph for apps without a dedicated icon (generic "open in new"). */
export const OPEN_IN_APP_ICON_FALLBACK = "\u{F0645}";

const KNOWN_APP_IDS = new Set(DEFAULT_EXTERNAL_APPS.map((app) => app.id));

/** A user-added app (from settings) rather than one of the built-in defaults. */
export function isCustomOpenInApp(id: string): boolean {
	return !KNOWN_APP_IDS.has(id);
}

const FILES_APP_IDS = new Set(["finder"]);
const TERMINAL_APP_IDS = new Set(["ghostty", "iterm", "terminal"]);

/** Coarse category for the launcher row subtitle; custom apps get their own bucket. */
export function openInAppCategory(id: string): "files" | "editor" | "terminal" | "custom" {
	if (isCustomOpenInApp(id)) return "custom";
	if (FILES_APP_IDS.has(id)) return "files";
	if (TERMINAL_APP_IDS.has(id)) return "terminal";
	return "editor";
}

/**
 * Brand colors for the "Open in…" squircle tiles. These are external-app brand
 * identities (theme-independent, white glyph on top), NOT theme chrome — kept as
 * hex here for the same reason STATUS_COLORS stays hex (see src/shared/types.ts).
 */
const OPEN_IN_APP_BRAND: Record<string, string> = {
	finder: "#4a90d9",
	vscode: "#2b9df4",
	cursor: "#8b5cf6",
	ghostty: "#38bdf8",
	iterm: "#10b981",
	terminal: "#64748b",
	intellij: "#ec4899",
	"intellij-ultimate": "#ec4899",
	"intellij-ce": "#ec4899",
	pycharm: "#22c55e",
	zed: "#f59e0b",
	sublime: "#f97316",
};

/** Deterministic palette for custom apps that have no known brand color. */
const CUSTOM_BRAND_PALETTE = ["#14b8a6", "#6366f1", "#ef4444", "#0ea5e9", "#d946ef", "#f43f5e", "#84cc16", "#a855f7"];

/** A stable brand color for any app id (known → brand map, custom → hashed palette). */
export function brandColorForApp(id: string): string {
	const known = OPEN_IN_APP_BRAND[id];
	if (known) return known;
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	return CUSTOM_BRAND_PALETTE[hash % CUSTOM_BRAND_PALETTE.length];
}
