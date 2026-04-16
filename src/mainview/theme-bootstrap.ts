export type ThemePreference = "dark" | "light" | "system";
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
	if (value === "dark" || value === "light" || value === "system") {
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
			: preference;

	return { preference, resolved };
}
