// Google Analytics 4 integration via Measurement Protocol
// Uses fetch() instead of gtag.js because WKWebView blocks external
// script loading from the views:// custom protocol.

const GA_MEASUREMENT_ID = "G-L1NSQH6FGY";
const GA_API_SECRET = "WlYPp7bSTVS5cMRMS4dJwQ";
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

let clientId = "";
let sessionId = "";
let userProperties: Record<string, { value: string }> = {};
let currentScreen = "dashboard";
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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

function sendToGA(events: Array<{ name: string; params?: Record<string, unknown> }>): void {
	const body = {
		client_id: clientId,
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

	userProperties = {
		operating_system: { value: getOS() },
		app_version: { value: appVersion },
	};

	// Send session_start event
	sendToGA([{ name: "session_start" }]);

	// Start heartbeat — ping every 60 seconds to keep user alive in Realtime
	if (heartbeatInterval) clearInterval(heartbeatInterval);
	heartbeatInterval = setInterval(() => {
		// Refresh session timestamp on every heartbeat
		sessionId = getOrCreateSessionId();
		trackEvent("heartbeat", { screen_name: currentScreen });
	}, 60_000);
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
