/**
 * Agent rate-limit parsing — pure functions shared by the bun process, the CLI
 * (`dev3 statusline`) and the renderer.
 *
 * Data sources:
 * - Claude Code: the statusLine stdin JSON carries `rate_limits.{five_hour,seven_day}`
 *   with `used_percentage` + `resets_at` (unix seconds). dev3 injects a statusLine
 *   wrapper (`dev3 statusline`) via `--settings` that dumps that JSON to
 *   `~/.dev3.0/data/rate-limits/claude.json`.
 * - Codex: rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 *   contain `event_msg`/`token_count` events with a `rate_limits` object
 *   (`primary`/`secondary` windows + `credits`). Windows may be null on
 *   usage-based/enterprise plans.
 * - Codex monthly credits: a read-only `account/rateLimits/read` request to the
 *   locally authenticated `codex app-server`; this is cached and optional.
 */

export type RateLimitSource = "claude" | "codex";

export interface RateLimitWindow {
	/** Stable window id, e.g. "five_hour", "seven_day", "primary", "secondary". */
	id: string;
	/** Percentage of the window already used, 0–100 (may exceed 100 briefly). */
	usedPercent: number;
	/** Absolute reset time in epoch ms, when known. */
	resetsAt: number | null;
	/** Window length in minutes, when known (Codex reports it; Claude implies it by id). */
	windowMinutes: number | null;
}

export interface MonthlyCreditLimit {
	limit: number;
	used: number;
	/** Percentage remaining, as reported by Codex. */
	remainingPercent: number;
	/** Absolute reset time in epoch ms, when known. */
	resetsAt: number | null;
}

export interface AgentRateLimitSnapshot {
	source: RateLimitSource;
	/** When this data was captured locally (epoch ms). */
	capturedAt: number;
	windows: RateLimitWindow[];
	/** Codex credits balance display string, when the plan exposes credits. */
	creditsBalance: string | null;
	/** Effective per-user monthly Codex credit limit, available from app-server. */
	monthlyCredits: MonthlyCreditLimit | null;
	/** Codex plan type, e.g. "enterprise_cbp_usage_based". */
	planType: string | null;
}

export interface AgentRateLimitsReport {
	snapshots: AgentRateLimitSnapshot[];
	generatedAt: number;
}

/** Usage percentage at which the indicator/segment escalates to warning. */
export const RATE_LIMIT_WARN_PERCENT = 80;
/** Usage percentage at which the indicator/segment escalates to danger. */
export const RATE_LIMIT_DANGER_PERCENT = 95;

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asFiniteNumber(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asNumeric(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim()) {
		const parsed = Number(v);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/** Human label for a window id ("five_hour" → "5h", codex "primary" → by minutes). */
export function windowLabel(w: RateLimitWindow): string {
	switch (w.id) {
		case "five_hour":
			return "5h";
		case "seven_day":
			return "7d";
		case "monthly_credits":
			return "monthly credits";
	}
	if (w.windowMinutes != null) {
		const mins = w.windowMinutes;
		if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
		if (mins >= 60) return `${Math.round(mins / 60)}h`;
		return `${mins}m`;
	}
	return w.id;
}

/** Compact "time until reset" like "42m", "2h13m", "3d2h". Empty when unknown/past. */
export function formatResetDelta(resetsAt: number | null, nowMs: number): string {
	if (resetsAt == null) return "";
	const deltaMin = Math.round((resetsAt - nowMs) / 60000);
	if (deltaMin <= 0) return "";
	if (deltaMin < 60) return `${deltaMin}m`;
	const hours = Math.floor(deltaMin / 60);
	if (hours < 24) {
		const m = deltaMin % 60;
		return m > 0 ? `${hours}h${m}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const h = hours % 24;
	return h > 0 ? `${days}d${h}h` : `${days}d`;
}

/**
 * Parse the Claude Code statusLine stdin payload into a snapshot.
 * Returns null when the payload carries no usable `rate_limits` object
 * (older Claude Code versions don't send it).
 */
export function parseClaudeStatusLinePayload(payload: unknown, capturedAt: number): AgentRateLimitSnapshot | null {
	const root = asRecord(payload);
	const rateLimits = asRecord(root?.rate_limits);
	if (!rateLimits) return null;

	const windows: RateLimitWindow[] = [];
	for (const id of ["five_hour", "seven_day"]) {
		const win = asRecord(rateLimits[id]);
		const usedPercent = asFiniteNumber(win?.used_percentage);
		if (win && usedPercent != null) {
			const resetsAtSec = asFiniteNumber(win.resets_at);
			windows.push({
				id,
				usedPercent,
				resetsAt: resetsAtSec != null ? resetsAtSec * 1000 : null,
				windowMinutes: id === "five_hour" ? 300 : 10080,
			});
		}
	}
	if (windows.length === 0) return null;
	return { source: "claude", capturedAt, windows, creditsBalance: null, monthlyCredits: null, planType: null };
}

/**
 * Parse a Codex `rate_limits` object (from a `token_count` rollout event).
 * `eventAtMs` anchors relative `resets_in_seconds` values (older Codex versions);
 * newer versions send absolute `resets_at` unix seconds.
 * Returns null when neither a window nor credits info is present.
 */
export function parseCodexRateLimits(rateLimits: unknown, eventAtMs: number): AgentRateLimitSnapshot | null {
	const root = asRecord(rateLimits);
	if (!root) return null;

	const windows: RateLimitWindow[] = [];
	for (const id of ["primary", "secondary"]) {
		const win = asRecord(root[id]);
		const usedPercent = asFiniteNumber(win?.used_percent);
		if (win && usedPercent != null) {
			const resetsAtSec = asFiniteNumber(win.resets_at);
			const resetsInSec = asFiniteNumber(win.resets_in_seconds);
			windows.push({
				id,
				usedPercent,
				resetsAt: resetsAtSec != null ? resetsAtSec * 1000 : resetsInSec != null ? eventAtMs + resetsInSec * 1000 : null,
				windowMinutes: asFiniteNumber(win.window_minutes),
			});
		}
	}

	const credits = asRecord(root.credits);
	let creditsBalance: string | null = null;
	if (credits && credits.has_credits === true) {
		creditsBalance = credits.unlimited === true ? "unlimited" : credits.balance != null ? String(credits.balance) : null;
	}

	const planType = typeof root.plan_type === "string" ? root.plan_type : null;
	if (windows.length === 0 && creditsBalance == null) return null;
	return { source: "codex", capturedAt: eventAtMs, windows, creditsBalance, monthlyCredits: null, planType };
}

/** Parse the camelCase rateLimits object returned by Codex app-server. */
export function parseCodexAppServerRateLimits(rateLimits: unknown, capturedAt: number): AgentRateLimitSnapshot | null {
	const root = asRecord(rateLimits);
	if (!root) return null;

	const windows: RateLimitWindow[] = [];
	for (const id of ["primary", "secondary"]) {
		const win = asRecord(root[id]);
		const usedPercent = asFiniteNumber(win?.usedPercent);
		if (win && usedPercent != null) {
			const resetsAtSec = asFiniteNumber(win.resetsAt);
			windows.push({
				id,
				usedPercent,
				resetsAt: resetsAtSec != null ? resetsAtSec * 1000 : null,
				windowMinutes: asFiniteNumber(win.windowDurationMins),
			});
		}
	}

	const credits = asRecord(root.credits);
	let creditsBalance: string | null = null;
	if (credits?.hasCredits === true) {
		creditsBalance = credits.unlimited === true ? "unlimited" : credits.balance != null ? String(credits.balance) : null;
	}

	const individual = asRecord(root.individualLimit);
	const limit = asNumeric(individual?.limit);
	const used = asNumeric(individual?.used);
	const reportedRemaining = asFiniteNumber(individual?.remainingPercent);
	let monthlyCredits: MonthlyCreditLimit | null = null;
	if (limit != null && limit > 0 && used != null && used >= 0) {
		const remainingPercent = reportedRemaining ?? Math.max(0, 100 - (used / limit) * 100);
		const resetsAtSec = asFiniteNumber(individual?.resetsAt);
		monthlyCredits = {
			limit,
			used,
			remainingPercent,
			resetsAt: resetsAtSec != null ? resetsAtSec * 1000 : null,
		};
		windows.push({
			id: "monthly_credits",
			usedPercent: Math.max(0, 100 - remainingPercent),
			resetsAt: monthlyCredits.resetsAt,
			windowMinutes: null,
		});
	}

	const planType = typeof root.planType === "string" ? root.planType : null;
	if (windows.length === 0 && creditsBalance == null) return null;
	return { source: "codex", capturedAt, windows, creditsBalance, monthlyCredits, planType };
}

/** Merge a fresh app-server snapshot over the rollout fallback without losing rollout-only windows. */
export function mergeCodexRateLimitSnapshots(
	rollout: AgentRateLimitSnapshot | null,
	live: AgentRateLimitSnapshot | null,
): AgentRateLimitSnapshot | null {
	if (!live) return rollout;
	if (!rollout) return live;
	const windows = new Map<string, RateLimitWindow>();
	for (const window of rollout.windows) windows.set(window.id, window);
	for (const window of live.windows) windows.set(window.id, window);
	return {
		source: "codex",
		capturedAt: live.capturedAt,
		windows: [...windows.values()],
		creditsBalance: live.creditsBalance ?? rollout.creditsBalance,
		monthlyCredits: live.monthlyCredits,
		planType: live.planType ?? rollout.planType,
	};
}

/**
 * Scan Codex rollout JSONL lines (oldest→newest) and return the snapshot from
 * the LAST `token_count` event carrying rate-limit info.
 */
export function extractCodexSnapshotFromRolloutLines(lines: string[]): AgentRateLimitSnapshot | null {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.includes('"rate_limits"')) continue;
		try {
			const entry = asRecord(JSON.parse(line));
			const payload = asRecord(entry?.payload);
			const rateLimits = payload?.rate_limits;
			if (!rateLimits) continue;
			const ts = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
			const snapshot = parseCodexRateLimits(rateLimits, Number.isFinite(ts) ? ts : 0);
			if (snapshot) return snapshot;
		} catch {
			// torn/partial line at a read boundary — keep scanning backwards
		}
	}
	return null;
}

/** The single most-constrained window across all snapshots (drives the ambient indicator). */
export function worstWindow(report: AgentRateLimitsReport): { source: RateLimitSource; window: RateLimitWindow } | null {
	let worst: { source: RateLimitSource; window: RateLimitWindow } | null = null;
	for (const snap of report.snapshots) {
		for (const win of snap.windows) {
			if (!worst || win.usedPercent > worst.window.usedPercent) {
				worst = { source: snap.source, window: win };
			}
		}
	}
	return worst;
}

const ANSI_DIM = "\x1b[90m";
const ANSI_WARN = "\x1b[33m";
const ANSI_DANGER = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

/**
 * Render the dev3 statusLine segment for a Claude snapshot, e.g.
 * "5h 12% ↻2h13m · 7d 81% ↻3d2h" — dim below the warn threshold, yellow ≥80%,
 * red ≥95%. Returns "" when there is nothing to show.
 */
export function formatStatusLineSegment(snapshot: AgentRateLimitSnapshot | null, nowMs: number): string {
	if (!snapshot || snapshot.windows.length === 0) return "";
	const parts = snapshot.windows.map((w) => {
		const color = w.usedPercent >= RATE_LIMIT_DANGER_PERCENT ? ANSI_DANGER : w.usedPercent >= RATE_LIMIT_WARN_PERCENT ? ANSI_WARN : ANSI_DIM;
		const reset = formatResetDelta(w.resetsAt, nowMs);
		return `${color}${windowLabel(w)} ${Math.round(w.usedPercent)}%${reset ? ` ↻${reset}` : ""}${ANSI_RESET}`;
	});
	return parts.join(`${ANSI_DIM} · ${ANSI_RESET}`);
}
