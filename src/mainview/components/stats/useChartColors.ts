import { useSyncExternalStore } from "react";

export interface ChartColors {
	/** Resolved accent, e.g. "rgb(68 150 255)". */
	accent: string;
	/** Raw accent triplet "r g b" for building rgb(... / alpha). */
	accentRaw: string;
	grid: string;
	axis: string;
	surface: string;
	/** Categorical slice palette, resolved to rgb(...). */
	slices: string[];
}

// Dark-theme fallbacks — only used when CSS isn't loaded (e.g. happy-dom tests).
const FALLBACK_RAW: Record<string, string> = {
	"--accent": "68 150 255",
	"--border-default": "32 38 55",
	"--text-muted": "100 116 139",
	"--surface-raised": "20 24 33",
	"--chart-1": "68 150 255",
	"--chart-2": "167 139 250",
	"--chart-3": "74 222 128",
	"--chart-4": "251 191 36",
	"--chart-5": "244 114 182",
	"--chart-6": "45 212 191",
};

function raw(name: string): string {
	if (typeof document !== "undefined") {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		if (v) return v;
	}
	return FALLBACK_RAW[name] ?? "128 128 128";
}

const SLICE_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];

function getAppTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	return (document.documentElement.dataset.theme as "dark" | "light") || "dark";
}

function subscribeToTheme(cb: () => void): () => void {
	const observer = new MutationObserver(cb);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

/**
 * Resolve the chart design tokens to concrete `rgb(...)` strings, re-reading
 * when the app theme flips. recharts applies colors as SVG attributes where
 * `var()` does not resolve, so charts must receive already-computed colors.
 */
export function useChartColors(): ChartColors {
	// Re-render on theme change; the snapshot is the theme string so React
	// recomputes the (cheap) color reads below on every flip.
	useSyncExternalStore(subscribeToTheme, getAppTheme, () => "dark" as const);
	const accentRaw = raw("--accent");
	return {
		accent: `rgb(${accentRaw})`,
		accentRaw,
		grid: `rgb(${raw("--border-default")})`,
		axis: `rgb(${raw("--text-muted")})`,
		surface: `rgb(${raw("--surface-raised")})`,
		slices: SLICE_VARS.map((v) => `rgb(${raw(v)})`),
	};
}
