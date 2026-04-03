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
