// Google Analytics 4 integration via Measurement Protocol
// Uses fetch() instead of gtag.js because WKWebView blocks external
// script loading from the views:// custom protocol.

import type { CodingAgent } from "../shared/types";
import type { Route } from "./state";
import { api } from "./rpc";
import { randomUUID } from "./uuid";

const GA_MEASUREMENT_ID = "G-L1NSQH6FGY";
const GA_API_SECRET = "WlYPp7bSTVS5cMRMS4dJwQ";
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let clientId = "";
let sessionId = "";
let userProperties: Record<string, { value: string }> = {};
let currentScreen = "dashboard";
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let errorTrackingSetup = false;
let sessionStartTime = 0;

// ── Engagement time (feeds GA4 `engagement_time_msec`) ──
// We report the real *foreground* time elapsed between hits, not a fixed
// constant, so GA4's "average engagement time" / "engaged sessions" mean
// something. `engagedMs` banks accumulated visible time; `engagementResumeTs`
// is the timestamp we've been counting from (0 = paused because the tab/window
// is hidden). Both flushed on every hit (see flushEngagementMs).
let engagedMs = 0;
let engagementResumeTs = 0;
let engagementTrackingSetup = false;

// Cap a single engagement report so a suspended laptop / clock jump can't spike
// the metric with a multi-hour "engaged" interval.
const MAX_ENGAGEMENT_MS = 30 * 60 * 1000;
// Public IP used for `ip_override`. GA4 Measurement Protocol does NOT geolocate
// web-stream hits from the request's source IP — without ip_override the
// Country/City dimensions stay "(not set)". Resolved best-effort (see
// resolvePublicIp); empty string until/unless a lookup succeeds.
let ipOverride = "";

const IP_CACHE_KEY = "dev3-ga-ip";
const IP_CACHE_TS_KEY = "dev3-ga-ip-ts";
const IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day

// Agents registered by the app (App.tsx) so events like `task_moved` can carry
// a human-readable agent name without threading the agents list everywhere.
let knownAgents: CodingAgent[] = [];

/** Register the current agent list so analytics can resolve agent names by id. */
export function registerAgents(agents: CodingAgent[]): void {
	knownAgents = agents;
}

/** Resolve an agent's display name from its id, "unknown" if not found/null. */
export function agentNameFromId(agentId: string | null | undefined): string {
	if (!agentId) return "unknown";
	return knownAgents.find((a) => a.id === agentId)?.name ?? "unknown";
}

/**
 * Resolve the user's public IP (best-effort) for `ip_override`, so GA4 can
 * geolocate events. Uses a cached value immediately if present, then refreshes
 * from api.ipify.org at most once a day. One request per app launch at most —
 * silent on any failure (analytics still works, just without geo this session).
 */
function resolvePublicIp(): void {
	const cached = localStorage.getItem(IP_CACHE_KEY) || "";
	if (cached) ipOverride = cached;

	const cachedTs = Number(localStorage.getItem(IP_CACHE_TS_KEY) || "0");
	if (cached && Date.now() - cachedTs < IP_CACHE_TTL_MS) return; // still fresh

	fetch("https://api.ipify.org?format=json")
		.then((res) => res.json())
		.then((data: { ip?: unknown }) => {
			if (data && typeof data.ip === "string" && data.ip) {
				ipOverride = data.ip;
				localStorage.setItem(IP_CACHE_KEY, data.ip);
				localStorage.setItem(IP_CACHE_TS_KEY, String(Date.now()));
			}
		})
		.catch(() => {
			// Best-effort — keep any cached IP, otherwise no geo this session.
		});
}

function getOrCreateClientId(): string {
	const key = "dev3-ga-client-id";
	let id = localStorage.getItem(key);
	if (!id) {
		id = randomUUID();
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

function isFirstVisit(): boolean {
	// Key string kept as-is (was the old first_open sentinel) so existing
	// installs are already marked "seen" — renaming it would re-fire first_visit
	// once for everyone and spike "New users".
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

/** Pause the engagement clock (tab/window hidden): bank the visible span so far. */
function pauseEngagement(now: number): void {
	if (engagementResumeTs) {
		engagedMs += now - engagementResumeTs;
		engagementResumeTs = 0;
	}
}

/** Resume the engagement clock (tab/window visible) if it was paused. */
function resumeEngagement(now: number): void {
	if (!engagementResumeTs) engagementResumeTs = now;
}

function onVisibilityChange(): void {
	const now = Date.now();
	if (document.visibilityState === "hidden") pauseEngagement(now);
	else resumeEngagement(now);
}

/** Wire visibility tracking once so we only count foreground time as engaged. */
function setupEngagementTracking(): void {
	if (engagementTrackingSetup) return;
	engagementTrackingSetup = true;
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}
}

/**
 * Foreground time (ms) accumulated since the last hit, then resets the
 * accumulator. Reported as GA4 `engagement_time_msec` so engagement metrics
 * reflect real usage instead of the old fixed "100". Capped at
 * MAX_ENGAGEMENT_MS to survive suspended timers / clock jumps.
 */
function flushEngagementMs(): number {
	const now = Date.now();
	if (engagementResumeTs) {
		engagedMs += now - engagementResumeTs;
		engagementResumeTs = now; // keep counting from now
	}
	const ms = Math.min(engagedMs, MAX_ENGAGEMENT_MS);
	engagedMs = 0;
	return ms;
}

function sendToGA(events: Array<{ name: string; params?: Record<string, unknown> }>): void {
	// Flush once per hit and attach only to the first event — GA4 sums
	// engagement_time_msec across events, so repeating it would multi-count the
	// same interval. Floor at 1 so every hit carries a positive engagement.
	const engagementMs = String(Math.max(1, flushEngagementMs()));
	const body = {
		client_id: clientId,
		user_agent: navigator.userAgent,
		// Lets GA4 derive Country/City — MP web hits are NOT geolocated otherwise.
		...(ipOverride ? { ip_override: ipOverride } : {}),
		user_properties: userProperties,
		events: events.map((e, index) => ({
			name: e.name,
			params: {
				session_id: sessionId,
				...(index === 0 ? { engagement_time_msec: engagementMs } : {}),
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

	// Reset the engagement clock for this launch and start counting immediately
	// unless we boot while hidden. setupEngagementTracking wires visibility once.
	engagedMs = 0;
	engagementResumeTs =
		typeof document === "undefined" || document.visibilityState !== "hidden" ? Date.now() : 0;
	setupEngagementTracking();

	// Load cached IP synchronously (so session_start can carry it) and kick off
	// a best-effort refresh for the geo dimensions.
	resolvePublicIp();

	userProperties = {
		operating_system: { value: getOS() },
		app_version: { value: appVersion },
		screen_resolution: { value: getScreenResolution() },
		language: { value: getLanguage() },
	};

	const initEvents: Array<{ name: string; params?: Record<string, unknown> }> = [];

	// first_visit — only on the very first launch on this device. This is the
	// WEB-stream new-user event and is what drives GA4's "New users" metric; the
	// old `first_open` is the app/Firebase-stream equivalent and does NOT count
	// on a web data stream (which is what we are — measurement_id "G-…").
	if (isFirstVisit()) {
		initEvents.push({ name: "first_visit" });
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

/** Tear down analytics (clears heartbeat interval). */
export function destroyAnalytics(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
	// Drop the in-memory geo IP; the next init re-reads it from the localStorage cache.
	ipOverride = "";
	// Tear down engagement tracking so a fresh init re-wires it cleanly.
	if (engagementTrackingSetup && typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisibilityChange);
	}
	engagementTrackingSetup = false;
	engagedMs = 0;
	engagementResumeTs = 0;
}

/** Human-facing GA4 location derived from a {@link Route}. */
export interface AnalyticsLocation {
	/** Short screen label (also used as heartbeat `screen_name`). */
	screen: string;
	/** GA4 `page_title`. */
	title: string;
	/**
	 * Path portion of `page_location`, always under the `/app` prefix so the app
	 * is trivially separable from the marketing landing page — both report into
	 * the SAME GA4 property (measurement_id "G-…"), so without the prefix their
	 * Page-path rows would be indistinguishable.
	 *
	 * The project identifier is the app's internal id, never the project *name*:
	 * a repo/folder name can be confidential (client under NDA, unreleased
	 * codename) and must not leave the machine. The task identifier is the
	 * human-readable per-project seq label (e.g. "981-1", see
	 * {@link taskSeqLabel}) when resolvable, falling back to the raw task id.
	 */
	path: string;
}

/**
 * Map a route to a GA4 location. Pure — safe to unit-test in isolation.
 *
 * `taskLabel` is the human-readable seq id (e.g. "981-1") for the route's task,
 * resolved by the caller from the loaded task list; when omitted (task not
 * loaded) the raw task id is used so the hit is never dropped.
 */
export function analyticsLocationForRoute(route: Route, taskLabel?: string): AnalyticsLocation {
	switch (route.screen) {
		case "dashboard":
			return { screen: "dashboard", title: "Dashboard", path: "/app/dashboard" };
		case "project":
			// Split view with a task selected is really the task surface; the bare
			// board (with or without an empty split list) is "kanban".
			return route.activeTaskId
				? { screen: "task", title: "Task", path: `/app/project/${route.projectId}/task/${taskLabel ?? route.activeTaskId}` }
				: { screen: "kanban", title: "Kanban", path: `/app/project/${route.projectId}/kanban` };
		case "project-terminal":
			return { screen: "project-terminal", title: "Project Terminal", path: `/app/project/${route.projectId}/terminal` };
		case "task":
			return { screen: "task", title: "Task", path: `/app/project/${route.projectId}/task/${taskLabel ?? route.taskId}` };
		case "project-settings":
			return { screen: "project-settings", title: "Project Settings", path: `/app/project/${route.projectId}/settings` };
		case "settings":
			return { screen: "settings", title: "Settings", path: "/app/settings" };
		case "changelog":
			return { screen: "changelog", title: "Changelog", path: "/app/changelog" };
		case "stats":
			return { screen: "stats", title: "Stats", path: "/app/stats" };
		case "gauge-demo":
			return { screen: "gauge-demo", title: "Gauge Demo", path: "/app/gauge-demo" };
		case "viewport-lab":
			return { screen: "viewport-lab", title: "Viewport Lab", path: "/app/viewport-lab" };
		case "native-pane-layout-lab":
			return { screen: "native-pane-layout-lab", title: "Native Pane Layout Lab", path: "/app/native-pane-layout-lab" };
		default:
			// Resilient fallback for any future route: never break telemetry over a
			// missing case — just log a generic /app hit.
			return { screen: "unknown", title: "dev-3.0", path: "/app" };
	}
}

// Synthetic host for the desktop/browser app's page_location. GA4 derives the
// "Page path" dimension by parsing page_location as a URL — but ONLY when it is a
// real http(s) URL; a custom scheme (the old `app://dev3/…`) leaves Page path
// "(not set)" even though page_title still arrives. Kept distinct from the
// landing page host (dev3.h0x91b.com) so the two are separable in the shared
// GA4 property (the `/app` path prefix separates them too).
const APP_LOCATION_ORIGIN = "https://dev3.local";

/** Build a full GA4 `page_location` (a parseable https URL) from an /app path. */
function pageLocation(path: string): string {
	return `${APP_LOCATION_ORIGIN}${path}`;
}

/**
 * Track a virtual page view for SPA navigation, derived from the route.
 * `taskLabel` (e.g. "981-1") is resolved by the caller from the loaded task
 * list; it lands in the path in place of the raw task id.
 */
export function trackPageView(route: Route, taskLabel?: string): void {
	const loc = analyticsLocationForRoute(route, taskLabel);
	currentScreen = loc.screen;
	sendToGA([{
		name: "page_view",
		params: {
			page_title: loc.title,
			page_location: pageLocation(loc.path),
		},
	}]);
}

/**
 * Track opening the inline diff viewer as its own virtual page view. The diff is
 * not a routable screen (it opens in-place over a task), so callers fire this
 * explicitly on open. `taskLabel` is the human-readable seq id (e.g. "981-1");
 * project id is the internal id, never the project name.
 */
export function trackDiffView(projectId: string, taskLabel: string): void {
	currentScreen = "diff";
	sendToGA([{
		name: "page_view",
		params: {
			page_title: "Diff",
			page_location: pageLocation(`/app/project/${projectId}/diff/${taskLabel}`),
		},
	}]);
}

/**
 * Track a single agent launch ("which agents are people using right now").
 *
 * Fires one `agent_launched` event per agent instance started, carrying just
 * the agent name and the permission mode so GA4 can break usage down by those.
 *
 * `agentId`/`configId` may be null — the caller's default-resolution mirrors
 * the launch path, so we resolve the same fallbacks here (default agent →
 * first agent; default config → first config).
 */
export function trackAgentLaunched(
	agents: CodingAgent[],
	agentId: string | null,
	configId: string | null,
): void {
	const agent =
		(agentId ? agents.find((a) => a.id === agentId) : null) ??
		agents.find((a) => a.isDefault) ??
		agents[0] ??
		null;

	const config = agent
		? (configId ? agent.configurations.find((c) => c.id === configId) : null) ??
			agent.configurations.find((c) => c.id === agent.defaultConfigId) ??
			agent.configurations[0] ??
			null
		: null;

	trackEvent("agent_launched", {
		agent_name: agent?.name ?? "unknown",
		permission_mode: config?.permissionMode ?? "default",
	});
}

/** Track a custom event. */
export function trackEvent(
	name: string,
	params?: Record<string, string | number | boolean>,
): void {
	sendToGA([{ name, params }]);
}

// ── Error tracking ──

/** Send error description to backend for local log file persistence. */
function logToBackend(description: string, source: "error" | "unhandledrejection"): void {
	api.request.logRendererError({ description, source }).catch(() => {});
}

/** Extract just the filename from a URL or path (e.g. "index-abc123.js" from "views://mainview/assets/index-abc123.js"). */
function extractFilename(raw: string): string {
	if (!raw) return "unknown";
	try {
		return raw.split("/").pop() || raw;
	} catch {
		return raw;
	}
}

/** Extract the first meaningful stack frame (skip the error message line). */
function extractStackLine(stack: string | undefined): string {
	if (!stack) return "no stack";
	const lines = stack.split("\n");
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line) return line;
	}
	return "no stack";
}

function setupErrorTracking(): void {
	if (errorTrackingSetup) return;
	errorTrackingSetup = true;

	window.addEventListener("error", (event) => {
		const file = extractFilename(event.filename);
		const description = `${event.message} at ${file}:${event.lineno}:${event.colno}`;
		trackEvent("app_exception", {
			description,
			fatal: false,
			error_source: "error",
			error_file: file,
			error_line: event.lineno,
			error_message: String(event.message).slice(0, 150),
		});
		logToBackend(description, "error");
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		const isError = reason instanceof Error;
		const message = isError ? reason.message : String(reason);
		const stackLine = isError ? extractStackLine(reason.stack) : "no stack";
		const description = `Unhandled rejection: ${message} | ${stackLine}`;
		trackEvent("app_exception", {
			description,
			fatal: false,
			error_source: "unhandledrejection",
			error_file: extractFilename(stackLine),
			error_message: message.slice(0, 150),
			stack_line: stackLine.slice(0, 200),
		});
		logToBackend(description, "unhandledrejection");
	});
}
