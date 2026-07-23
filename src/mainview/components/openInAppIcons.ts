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
