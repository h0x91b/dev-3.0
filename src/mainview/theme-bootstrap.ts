import { beigeCssDeclarations, clampBeigeTone, formatBeigeTone, type BeigeTone } from "../shared/beige-palette";

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
	__DEV3_INITIAL_BEIGE_TONE__?: unknown;
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

const BEIGE_TONE_KEY = "dev3-beige-tone";
const BEIGE_STYLE_ID = "dev3-beige-tone";

/** This window's cached copy of the host's tone; undefined until one was seen here. */
export function readStoredBeigeTone(): BeigeTone | undefined {
	try {
		const raw = localStorage.getItem(BEIGE_TONE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : undefined;
		return parsed && typeof parsed === "object" ? clampBeigeTone(parsed) : undefined;
	} catch {
		return undefined;
	}
}

/** The tone to paint before the host answers: the host's (injected into a remote
 *  browser), else this window's cache of it, else the default. */
export function readBeigeTone(): BeigeTone {
	const injected = (window as Window & ThemeBootstrapWindow).__DEV3_INITIAL_BEIGE_TONE__;
	if (injected && typeof injected === "object") return clampBeigeTone(injected);
	return readStoredBeigeTone() ?? clampBeigeTone(undefined);
}

/** The host's saved tone, or undefined while it has none. settings.json is the one
 *  source of truth; localStorage only caches it so the first frame paints right. */
export function hostBeigeTone(settings: { beigeDepth?: number; beigeWarmth?: number }): BeigeTone | undefined {
	if (settings.beigeDepth === undefined && settings.beigeWarmth === undefined) return undefined;
	return clampBeigeTone({ depth: settings.beigeDepth, warmth: settings.beigeWarmth });
}

/** Adopt the host's tone in this window, unless it is the one already painted. */
export function adoptHostBeigeTone(settings: { beigeDepth?: number; beigeWarmth?: number }): void {
	const tone = hostBeigeTone(settings);
	if (!tone) return;
	saveBeigeTone(tone);
	if (document.documentElement.dataset.beigeTone !== formatBeigeTone(tone)) applyBeigeTone(tone);
}

export function saveBeigeTone(tone: BeigeTone): void {
	try { localStorage.setItem(BEIGE_TONE_KEY, JSON.stringify(clampBeigeTone(tone))); } catch { /* private mode */ }
}

/** Writes the tone-driven tokens. Scoped to the beige selector, so dropping
 *  `data-palette` (Light, Dark, a GaugeDemo preview) switches them off with no cleanup. */
export function applyBeigeTone(next: BeigeTone): void {
	const tone = clampBeigeTone(next);
	let style = document.getElementById(BEIGE_STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = BEIGE_STYLE_ID;
		document.head.appendChild(style);
	}
	style.textContent = `[data-theme="light"][data-palette="beige"] { ${beigeCssDeclarations(tone)} }`;
	document.documentElement.dataset.beigeTone = formatBeigeTone(tone);
}

/** Beige is a palette over the light theme, so everything keyed on `light` (terminal, ANSI adapt) still applies. */
export function applyThemeToDocument(preference: ThemePreference, resolved: ResolvedTheme): void {
	const root = document.documentElement;
	root.dataset.theme = resolved;
	if (preference === "beige") {
		root.dataset.palette = "beige";
		applyBeigeTone(readBeigeTone());
	} else {
		delete root.dataset.palette;
	}
}
