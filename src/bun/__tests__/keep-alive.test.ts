import { describe, expect, it } from "vitest";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitWindow } from "../../shared/rate-limits";
import {
	KEEP_ALIVE_BACKOFF_BASE_MS,
	KEEP_ALIVE_BACKOFF_MAX_MS,
	KEEP_ALIVE_RATE_LIMIT_BUFFER_MS,
	keepAliveBackoffMs,
	keepAliveRateLimitSource,
	keepAliveRateLimitWaitUntil,
	keepAliveSnapshotResetMs,
	nextKeepAliveState,
} from "../../shared/keep-alive";

const NOW = 1_000_000;

function win(usedPercent: number, resetsAt: number | null): RateLimitWindow {
	return { id: "w", usedPercent, resetsAt, windowMinutes: null };
}

function snap(source: "claude" | "codex", accountId: string | null, windows: RateLimitWindow[]): AgentRateLimitSnapshot {
	return { source, accountId, capturedAt: NOW, windows, creditsBalance: null, monthlyCredits: null, planType: null };
}

function report(snapshots: AgentRateLimitSnapshot[]): AgentRateLimitsReport {
	return { snapshots, generatedAt: NOW };
}

describe("nextKeepAliveState", () => {
	it("returns a fresh watching state when enabled, and null when disabled", () => {
		expect(nextKeepAliveState(true)).toEqual({
			enabled: true,
			status: "watching",
			attempts: 0,
			lastAttemptAt: null,
			nextAttemptAt: null,
			lastVerdict: null,
			gaveUpReason: null,
		});
		expect(nextKeepAliveState(false)).toBeNull();
	});
});

describe("keepAliveBackoffMs", () => {
	it("starts at the base, doubles, never exceeds the cap, and treats zero as the first attempt", () => {
		expect(keepAliveBackoffMs(1)).toBe(KEEP_ALIVE_BACKOFF_BASE_MS);
		expect(keepAliveBackoffMs(2)).toBe(KEEP_ALIVE_BACKOFF_BASE_MS * 2);
		expect(keepAliveBackoffMs(3)).toBe(KEEP_ALIVE_BACKOFF_BASE_MS * 4);
		expect(keepAliveBackoffMs(100)).toBe(KEEP_ALIVE_BACKOFF_MAX_MS);
		expect(keepAliveBackoffMs(0)).toBe(KEEP_ALIVE_BACKOFF_BASE_MS);
	});
});

describe("keepAliveRateLimitSource", () => {
	it("maps only claude and codex", () => {
		expect(keepAliveRateLimitSource("claude")).toBe("claude");
		expect(keepAliveRateLimitSource("codex")).toBe("codex");
		expect(keepAliveRateLimitSource("gemini")).toBeNull();
		expect(keepAliveRateLimitSource(null)).toBeNull();
		expect(keepAliveRateLimitSource(undefined)).toBeNull();
	});
});

describe("keepAliveSnapshotResetMs", () => {
	it("returns the latest reset among blocked windows with a future reset", () => {
		const s = snap("claude", null, [win(100, NOW + 5_000), win(100, NOW + 9_000), win(50, NOW + 99_000)]);
		expect(keepAliveSnapshotResetMs(s, NOW)).toBe(NOW + 9_000);
	});
	it("ignores windows under the threshold, a reset already in the past, and a blocked window with no known reset", () => {
		expect(keepAliveSnapshotResetMs(snap("claude", null, [win(99, NOW + 5_000)]), NOW), "under threshold").toBeNull();
		expect(keepAliveSnapshotResetMs(snap("claude", null, [win(100, NOW - 5_000)]), NOW), "past reset").toBeNull();
		expect(keepAliveSnapshotResetMs(snap("claude", null, [win(100, null)]), NOW), "unknown reset").toBeNull();
	});
});

describe("keepAliveRateLimitWaitUntil", () => {
	it("returns reset + buffer for the matching login only, never a different account or source", () => {
		const r = report([snap("claude", "acct-1", [win(100, NOW + 5_000)])]);
		expect(keepAliveRateLimitWaitUntil(r, "claude", "acct-1", NOW)).toBe(NOW + 5_000 + KEEP_ALIVE_RATE_LIMIT_BUFFER_MS);
		expect(keepAliveRateLimitWaitUntil(r, "claude", "acct-2", NOW)).toBeNull();
		expect(keepAliveRateLimitWaitUntil(r, "codex", "acct-1", NOW)).toBeNull();
	});
	it("treats null account as the system login", () => {
		const r = report([snap("codex", null, [win(100, NOW + 3_000)])]);
		expect(keepAliveRateLimitWaitUntil(r, "codex", null, NOW)).toBe(NOW + 3_000 + KEEP_ALIVE_RATE_LIMIT_BUFFER_MS);
	});
	it("returns null when not blocked or when the report is null", () => {
		expect(keepAliveRateLimitWaitUntil(report([snap("claude", null, [win(10, NOW + 5_000)])]), "claude", null, NOW)).toBeNull();
		expect(keepAliveRateLimitWaitUntil(null, "claude", null, NOW)).toBeNull();
	});
	it("does not defer a reset further out than the cap (a weekly limit)", () => {
		const farOut = NOW + 3 * 24 * 60 * 60_000; // 3 days — a weekly-class reset
		const r = report([snap("claude", null, [win(100, farOut)])]);
		expect(keepAliveRateLimitWaitUntil(r, "claude", null, NOW)).toBeNull();
	});
});
