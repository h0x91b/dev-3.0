import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { init } from "ghostty-web";
import "./index.css";
import "./rpc";
import App from "./App";
import { I18nProvider } from "./i18n";
import { MobileProvider } from "./hooks/useMobile";
import { initAnalytics } from "./analytics";
import { api } from "./rpc";
import { bootstrapZoom } from "./zoom";

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
	const resolved: "dark" | "light" =
		saved === "system" ? (systemThemeMq.matches ? "dark" : "light") : (saved as "dark" | "light");
	document.documentElement.dataset.theme = resolved;
	api.request.setTmuxTheme({ theme: resolved }).catch(() => {});
}

applySavedTheme();
systemThemeMq.addEventListener("change", applySavedTheme);

// Apply saved zoom before React mounts (see zoom.ts for implementation)
bootstrapZoom();

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
		const { version } = await Promise.race([
			api.request.getAppVersion(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
		]);
		initAnalytics(version);
		document.title = `dev-3.0 v${version}`;
	} catch (err) {
		console.warn("[main] Failed to init analytics:", err);
		initAnalytics("unknown");
		document.title = "dev-3.0";
	}

	console.log("[main] Rendering React app...");
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<MobileProvider>
				<I18nProvider>
					<App />
				</I18nProvider>
			</MobileProvider>
		</StrictMode>,
	);
	console.log("[main] React app rendered");
}

bootstrap().catch((err) => {
	console.error("[main] bootstrap() CRASHED:", err);
});
