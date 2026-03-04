import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { init } from "ghostty-web";
import "./index.css";
import "./rpc";
import App from "./App";
import { I18nProvider } from "./i18n";
import { initAnalytics } from "./analytics";
import { api } from "./rpc";

// ── Global crash handlers (renderer) ──
// Catch unhandled errors that would otherwise silently kill the page.
window.addEventListener("error", (event) => {
	console.error("[RENDERER UNCAUGHT ERROR]", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		error: event.error,
		stack: event.error?.stack ?? "no stack",
	});
});

window.addEventListener("unhandledrejection", (event) => {
	console.error("[RENDERER UNHANDLED REJECTION]", {
		reason: event.reason,
		stack: event.reason?.stack ?? "no stack",
	});
});

// Apply saved theme before React mounts & keep in sync with OS
const systemThemeMq = window.matchMedia("(prefers-color-scheme: dark)");

function applySavedTheme() {
	const saved = localStorage.getItem("dev3-theme") || "dark";
	document.documentElement.dataset.theme =
		saved === "system" ? (systemThemeMq.matches ? "dark" : "light") : saved;
}

applySavedTheme();
systemThemeMq.addEventListener("change", applySavedTheme);

// Apply saved zoom before React mounts
const ZOOM_KEY = "dev3-zoom";
const DEFAULT_ZOOM = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;

function applyZoom(level: number) {
	const clamped = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level)) * 100) / 100;
	(document.documentElement.style as any).zoom = String(clamped);
	localStorage.setItem(ZOOM_KEY, String(clamped));
	window.dispatchEvent(new CustomEvent("zoom-changed", { detail: clamped }));
}

function getZoom(): number {
	return parseFloat(localStorage.getItem(ZOOM_KEY) || String(DEFAULT_ZOOM));
}

function adjustZoom(delta: number) {
	applyZoom(getZoom() + delta);
}

// Apply on load
applyZoom(getZoom());

// Expose for use by components
(window as any).__dev3Zoom = { applyZoom, getZoom, adjustZoom, ZOOM_STEP, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM };

// Apply saved locale before React mounts
const savedLocale = localStorage.getItem("dev3-locale") || "en";
document.documentElement.lang = savedLocale;

async function bootstrap() {
	console.log("[main] bootstrap() starting...");
	try {
		console.log("[main] Initializing ghostty-web...");
		await init();
		console.log("[main] ghostty-web initialized");
	} catch (err) {
		console.error("[main] ghostty-web init() FAILED:", err);
		console.error("[main] This will prevent terminal rendering. Error:", {
			message: (err as Error)?.message,
			stack: (err as Error)?.stack,
		});
	}

	// Initialize Google Analytics with app version
	try {
		const { version } = await api.request.getAppVersion();
		initAnalytics(version);
	} catch (err) {
		console.warn("[main] Failed to init analytics:", err);
		initAnalytics("unknown");
	}

	console.log("[main] Rendering React app...");
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<I18nProvider>
				<App />
			</I18nProvider>
		</StrictMode>,
	);
	console.log("[main] React app rendered");
}

bootstrap().catch((err) => {
	console.error("[main] bootstrap() CRASHED:", err);
});
