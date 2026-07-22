import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { init } from "ghostty-web";
import "./index.css";
import "./rpc";
import App from "./App";
import { I18nProvider } from "./i18n";
import { MobileProvider, detectMobile } from "./hooks/useMobile";
import { initAnalytics } from "./analytics";
import { api, isElectrobun } from "./rpc";
import { initAutoFullscreen } from "./fullscreen";
import { bootstrapZoom } from "./zoom";
import { bootstrapScrollSpeed } from "./scroll-speed";
import { getInitialThemeState, getWindowInjectedThemeState } from "./theme-bootstrap";
import { initStreamerMode } from "./streamer-mode";
import RootErrorBoundary from "./components/RootErrorBoundary";
import MobilePortraitGate from "./components/MobilePortraitGate";
import { recordError, recordRejection } from "./diagnostics";

// ── Global crash handlers (renderer) ──
// Catch unhandled errors that would otherwise silently kill the page. Besides
// the console (invisible on a phone with no devtools), feed them into the
// in-UI diagnostics store so the user can actually SEE and report them.
window.addEventListener("error", (event) => {
	console.error("[RENDERER UNCAUGHT ERROR]", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		error: event.error,
		stack: event.error?.stack ?? "no stack",
	});
	// Ignore benign resource-load "error" events (img/script) that carry no message.
	if (event.message) {
		const file = (event.filename || "").split("/").pop() || event.filename || "";
		recordError(
			event.message,
			event.error?.stack ?? undefined,
			file ? `${file}:${event.lineno}:${event.colno}` : undefined,
		);
	}
});

window.addEventListener("unhandledrejection", (event) => {
	console.error("[RENDERER UNHANDLED REJECTION]", {
		reason: event.reason,
		stack: event.reason?.stack ?? "no stack",
	});
	const reason = event.reason;
	const isError = reason instanceof Error;
	recordRejection(
		isError ? reason.message : String(reason),
		isError ? reason.stack ?? undefined : undefined,
		"unhandledrejection",
	);
});

// Apply saved theme before React mounts & keep in sync with OS
const systemThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
// Consumed once on first call so OS-change reruns don't override the user's manual choice.
let injectedThemeState = getWindowInjectedThemeState();

function applySavedTheme() {
	const { preference, resolved } = getInitialThemeState({
		localStorageTheme: localStorage.getItem("dev3-theme"),
		prefersDark: systemThemeMq.matches,
		...injectedThemeState,
	});
	injectedThemeState = {};
	document.documentElement.dataset.theme = resolved;
	localStorage.setItem("dev3-theme", preference);
	api.request.setTmuxTheme({ theme: resolved, preference }).catch(() => {});
}

applySavedTheme();
systemThemeMq.addEventListener("change", applySavedTheme);

// Apply saved zoom before React mounts (see zoom.ts for implementation)
bootstrapZoom();

// Apply saved streamer mode (privacy masking) before React mounts
initStreamerMode();

// Mobile remote mode: enter fullscreen on the first tap after load (browser
// chrome wastes a big share of a phone screen). Desktop/Electrobun only get
// the fullscreenchange subscription for the menu toggle. See fullscreen.ts.
initAutoFullscreen({ mobile: !isElectrobun && detectMobile() });

// Load saved terminal scroll speed into cache before terminals mount
bootstrapScrollSpeed();

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

	// Initialize Google Analytics with app version.
	// Await with a 5s timeout so desktop IPC stays sequential (avoids
	// Electrobun message loss under burst) while mobile/browser doesn't
	// block forever if WS isn't connected.
	try {
		const { version, buildChannel } = await Promise.race([
			api.request.getAppVersion(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
		]);
		initAnalytics(version);
		// Dev builds (channel "dev" = `bun run dev` from source) get a visible
		// prefix so the window is unmistakable next to an installed prod window.
		const devPrefix = buildChannel === "dev" ? "[DEV from src] " : "";
		document.title = `${devPrefix}dev-3.0 v${version}`;
	} catch (err) {
		console.warn("[main] Failed to init analytics:", err);
		initAnalytics("unknown");
		document.title = "dev-3.0";
	}

	console.log("[main] Rendering React app...");
	// RootErrorBoundary wraps the providers (not just <App/>) so a crash in
	// I18nProvider/MobileProvider themselves still renders a visible fallback
	// instead of a blank, unmounted tree.
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<RootErrorBoundary>
				<MobileProvider>
					<I18nProvider>
						<MobilePortraitGate>
							<App />
						</MobilePortraitGate>
					</I18nProvider>
				</MobileProvider>
			</RootErrorBoundary>
		</StrictMode>,
	);
	console.log("[main] React app rendered");
}

bootstrap().catch((err) => {
	console.error("[main] bootstrap() CRASHED:", err);
});
