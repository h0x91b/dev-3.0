// Google Analytics 4 integration via Measurement Protocol
// Uses fetch() instead of gtag.js because WKWebView blocks external
// script loading from the views:// custom protocol.

import type { CodingAgent } from "../shared/types";
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
		// Lets GA4 derive Country/City — MP web hits are NOT geolocated otherwise.
		...(ipOverride ? { ip_override: ipOverride } : {}),
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

/** Tear down analytics (clears heartbeat interval). */
export function destroyAnalytics(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
	// Drop the in-memory geo IP; the next init re-reads it from the localStorage cache.
	ipOverride = "";
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
