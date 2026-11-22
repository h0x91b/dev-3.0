import { beigeHex, parseBeigeTone } from "../shared/beige-palette";

/** Terminal palettes for both app themes, shared by the terminal and the prompt previews. */
export const DARK_TERMINAL_THEME = {
	background: "#1a1b26",
	foreground: "#a9b1d6",
	cursor: "#c0caf5",
	selectionBackground: "#33467c",
	black: "#15161e",
	red: "#f7768e",
	green: "#9ece6a",
	yellow: "#e0af68",
	blue: "#7aa2f7",
	magenta: "#bb9af7",
	cyan: "#7dcfff",
	white: "#a9b1d6",
	brightBlack: "#414868",
	brightRed: "#f7768e",
	brightGreen: "#9ece6a",
	brightYellow: "#e0af68",
	brightBlue: "#7aa2f7",
	brightMagenta: "#bb9af7",
	brightCyan: "#7dcfff",
	brightWhite: "#c0caf5",
};

export const LIGHT_TERMINAL_THEME = {
	background: "#ffffff",
	foreground: "#24292f",
	cursor: "#24292f",
	selectionBackground: "#0366d625",
	black: "#24292e",
	red: "#d73a49",
	green: "#28a745",
	yellow: "#9a6700",
	blue: "#005cc5",
	magenta: "#5a32a3",
	cyan: "#0598bc",
	white: "#57606a",
	brightBlack: "#6e7781",
	brightRed: "#cb2431",
	brightGreen: "#22863a",
	brightYellow: "#b08800",
	brightBlue: "#0366d6",
	brightMagenta: "#6f42c1",
	brightCyan: "#3192aa",
	brightWhite: "#d1d5da",
};

/** The palette for the current app theme: Beige swaps Light's white paper for the
 *  same warm background tmux paints, at the sliders' tone. */
export function terminalThemeFor(resolved: "dark" | "light"): typeof LIGHT_TERMINAL_THEME {
	if (resolved !== "light") return DARK_TERMINAL_THEME;
	const { palette, beigeTone } = document.documentElement.dataset;
	if (palette !== "beige") return LIGHT_TERMINAL_THEME;
	const background = beigeHex("tmux-bg", parseBeigeTone(beigeTone));
	return { ...LIGHT_TERMINAL_THEME, background, foreground: "#3d3a34", cursor: "#3d3a34" };
}
