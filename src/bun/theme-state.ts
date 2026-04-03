export const DEV3_CODEX_LIGHT_PROFILE = "dev3-light";
export const DEV3_CODEX_DARK_PROFILE = "dev3-dark";

let currentUiTheme: "dark" | "light" = "dark";

export function setCurrentUiTheme(theme: "dark" | "light"): void {
	currentUiTheme = theme;
}

export function getCurrentUiTheme(): "dark" | "light" {
	return currentUiTheme;
}

export function getCodexThemeForCurrentUiTheme(): "dracula" | "github" {
	return currentUiTheme === "light" ? "github" : "dracula";
}

export function getCodexProfileForCurrentUiTheme(): typeof DEV3_CODEX_LIGHT_PROFILE | typeof DEV3_CODEX_DARK_PROFILE {
	return currentUiTheme === "light" ? DEV3_CODEX_LIGHT_PROFILE : DEV3_CODEX_DARK_PROFILE;
}
