// Google Analytics 4 integration via Measurement Protocol
// Uses fetch() instead of gtag.js because WKWebView blocks external
// script loading from the views:// custom protocol.

const GA_MEASUREMENT_ID = "G-L1NSQH6FGY";
const GA_API_SECRET = "WlYPp7bSTVS5cMRMS4dJwQ";
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let clientId = "";
let sessionId = "";
let userProperties: Record<string, { value: string }> = {};
let currentScreen = "dashboard";
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let sessionStartTime = 0;

function getOrCreateClientId(): string {
	const key = "dev3-ga-client-id";
	let id = localStorage.getItem(key);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(key, id);
	}
	return id;
}

function getOrCreateSessionId(): string {
	// Session = app launch. Generate a numeric session ID (GA4 requires numeric string).
	const key = "dev3-ga-session-id";
	const keyTs = "dev3-ga-session-ts";
	const now = Date.now();
	const lastTs = Number(localStorage.getItem(keyTs) || "0");
	let id = localStorage.getItem(key);

	// New session if >30 min gap or no existing session
	if (!id || now - lastTs > 30 * 60 * 1000) {
		id = String(Math.floor(now / 1000));
		localStorage.setItem(key, id);
	}
	localStorage.setItem(keyTs, String(now));
	return id;
}

function getOS(): string {
	const ua = navigator.userAgent;
	if (ua.includes("Mac")) return "macOS";
	if (ua.includes("Windows")) return "Windows";
	if (ua.includes("Linux")) return "Linux";
	return navigator.platform || "unknown";
}

function getScreenResolution(): string {
	return `${screen.width}x${screen.height}`;
}

function getLanguage(): string {
	return navigator.language || "unknown";
}

function isFirstOpen(): boolean {
	const key = "dev3-ga-first-open-sent";
	if (!localStorage.getItem(key)) {
		localStorage.setItem(key, "1");
		return true;
	}
	return false;
}

function getSessionDurationSec(): number {
	if (!sessionStartTime) return 0;
	return Math.floor((Date.now() - sessionStartTime) / 1000);
}

function sendToGA(events: Array<{ name: string; params?: Record<string, unknown> }>): void {
	const body = {
		client_id: clientId,
		user_agent: navigator.userAgent,
		user_properties: userProperties,
		events: events.map((e) => ({
			name: e.name,
			params: {
				session_id: sessionId,
				engagement_time_msec: "100",
				...e.params,
			},
		})),
	};

	fetch(GA_ENDPOINT, {
		method: "POST",
		body: JSON.stringify(body),
	}).catch(() => {
		// Silently ignore network errors
	});
}

/** Initialize GA4 with user properties and start heartbeat. */
export function initAnalytics(appVersion: string): void {
	clientId = getOrCreateClientId();
	sessionId = getOrCreateSessionId();
	sessionStartTime = Date.now();

	userProperties = {
		operating_system: { value: getOS() },
		app_version: { value: appVersion },
		screen_resolution: { value: getScreenResolution() },
		language: { value: getLanguage() },
	};

	const initEvents: Array<{ name: string; params?: Record<string, unknown> }> = [];

	// first_open — only on the very first app launch (drives "New users" metric in GA4)
	if (isFirstOpen()) {
		initEvents.push({ name: "first_open" });
	}

	// app_update — fires when the app version changes (not on first open)
	const previousAppVersion = localStorage.getItem("dev3-ga-last-version") || "";
	if (previousAppVersion && previousAppVersion !== appVersion) {
		initEvents.push({
			name: "app_update",
			params: {
				previous_version: previousAppVersion,
				current_version: appVersion,
			},
		});
	}
	localStorage.setItem("dev3-ga-last-version", appVersion);

	// session_start — always
	initEvents.push({ name: "session_start" });

	sendToGA(initEvents);

	// Start heartbeat — ping every 10 minutes to keep user alive in Realtime
	if (heartbeatInterval) clearInterval(heartbeatInterval);
	heartbeatInterval = setInterval(() => {
		sessionId = getOrCreateSessionId();
		trackEvent("heartbeat", {
			screen_name: currentScreen,
			session_duration_sec: getSessionDurationSec(),
		});
	}, HEARTBEAT_INTERVAL_MS);

	// Global error tracking
	setupErrorTracking();
}

/** Track a virtual page view (for SPA navigation). */
export function trackPageView(screenName: string): void {
	currentScreen = screenName;
	sendToGA([{
		name: "page_view",
		params: {
			page_title: screenName,
			page_location: `app://dev3/${screenName}`,
		},
	}]);
}

/** Track a custom event. */
export function trackEvent(
	name: string,
	params?: Record<string, string | number | boolean>,
): void {
	sendToGA([{ name, params }]);
}

// ── Error tracking ──

function setupErrorTracking(): void {
	window.addEventListener("error", (event) => {
		trackEvent("app_exception", {
			description: `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
			fatal: false,
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		const description = reason instanceof Error
			? `${reason.message} | ${reason.stack?.split("\n")[1]?.trim() || "no stack"}`
			: String(reason);
		trackEvent("app_exception", {
			description: `Unhandled rejection: ${description}`,
			fatal: false,
		});
	});
}
