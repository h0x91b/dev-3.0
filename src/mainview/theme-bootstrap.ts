import { BEIGE_CSS_TOKENS, beigeColor, clampBeigeDepth, DEFAULT_BEIGE_DEPTH } from "../shared/beige-palette";

export type ThemePreference = "dark" | "light" | "beige" | "system";
export type ResolvedTheme = "dark" | "light";

interface ThemeBootstrapOptions {
	localStorageTheme: string | null;
	injectedTheme?: string | null;
	injectedResolvedTheme?: string | null;
	prefersDark: boolean;
}

interface ThemeBootstrapWindow {
	__DEV3_INITIAL_THEME__?: string;
	__DEV3_INITIAL_RESOLVED_THEME__?: string;
}

function parseThemePreference(value: string | null | undefined): ThemePreference | undefined {
	if (value === "dark" || value === "light" || value === "beige" || value === "system") {
		return value;
	}
	return undefined;
}

function parseResolvedTheme(value: string | null | undefined): ResolvedTheme | undefined {
	if (value === "dark" || value === "light") {
		return value;
	}
	return undefined;
}

export function getWindowInjectedThemeState(win: Window & typeof globalThis = window): {
	injectedTheme?: ThemePreference;
	injectedResolvedTheme?: ResolvedTheme;
} {
	const bootstrapWindow = win as Window & typeof globalThis & ThemeBootstrapWindow;
	return {
		injectedTheme: parseThemePreference(bootstrapWindow.__DEV3_INITIAL_THEME__),
		injectedResolvedTheme: parseResolvedTheme(bootstrapWindow.__DEV3_INITIAL_RESOLVED_THEME__),
	};
}

export function getInitialThemeState(options: ThemeBootstrapOptions): {
	preference: ThemePreference;
	resolved: ResolvedTheme;
} {
	const injectedTheme = parseThemePreference(options.injectedTheme);
	const localStorageTheme = parseThemePreference(options.localStorageTheme);
	const injectedResolvedTheme = parseResolvedTheme(options.injectedResolvedTheme);
	const preference = injectedTheme ?? localStorageTheme ?? "dark";
	const resolved =
		preference === "system"
			? injectedResolvedTheme ?? (options.prefersDark ? "dark" : "light")
			: preference === "beige" ? "light" : preference;

	return { preference, resolved };
}

const BEIGE_DEPTH_KEY = "dev3-beige-depth";
const BEIGE_STYLE_ID = "dev3-beige-depth";

export function readBeigeDepth(): number {
	try {
		return clampBeigeDepth(localStorage.getItem(BEIGE_DEPTH_KEY) ?? undefined);
	} catch {
		return DEFAULT_BEIGE_DEPTH;
	}
}

/** Writes the depth-driven surface tokens. Scoped to the beige selector, so dropping
 *  `data-palette` (Light, Dark, a GaugeDemo preview) switches them off with no cleanup. */
export function applyBeigeDepth(depth: number): void {
	const d = clampBeigeDepth(depth);
	try { localStorage.setItem(BEIGE_DEPTH_KEY, String(d)); } catch { /* private mode */ }
	let style = document.getElementById(BEIGE_STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = BEIGE_STYLE_ID;
		document.head.appendChild(style);
	}
	const vars = BEIGE_CSS_TOKENS.map((token) => `--${token}: ${beigeColor(token, d).join(" ")};`).join(" ");
	style.textContent = `[data-theme="light"][data-palette="beige"] { ${vars} }`;
	document.documentElement.dataset.beigeDepth = String(d);
}

/** Beige is a palette over the light theme, so everything keyed on `light` (terminal, ANSI adapt) still applies. */
export function applyThemeToDocument(preference: ThemePreference, resolved: ResolvedTheme): void {
	const root = document.documentElement;
	root.dataset.theme = resolved;
	if (preference === "beige") {
		root.dataset.palette = "beige";
		applyBeigeDepth(readBeigeDepth());
	} else {
		delete root.dataset.palette;
	}
}
