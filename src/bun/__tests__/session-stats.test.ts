import { describe, expect, it } from "vitest";
import {
	formatCostUsd,
	formatDurationMs,
	formatTokenCount,
	isSessionCacheWarm,
	MAX_ATTENTION_SESSIONS,
	attentionSessions,
	parseClaudeSessionStats,
	sessionAttention,
	sortSessions,
	summarizeSessions,
	type ClaudeSessionStats,
} from "../../shared/session-stats";

const PAYLOAD = {
	model: { id: "claude-opus-5-5[1m]", display_name: "Opus 5.5 (1M context)" },
	effort: { level: "medium" },
	session_name: "Status view display options",
	thinking: { enabled: true },
	cost: { total_cost_usd: 0.657, total_duration_ms: 62_816, total_api_duration_ms: 40_044, total_lines_added: 3, total_lines_removed: 1 },
	context_window: {
		total_input_tokens: 82_766,
		total_output_tokens: 8,
		context_window_size: 1_000_000,
		used_percentage: 8,
		current_usage: { input_tokens: 2, output_tokens: 8, cache_creation_input_tokens: 3070, cache_read_input_tokens: 79_694 },
	},
	prompt_cache: { warm: true, ttl: "1h", expires_at: 1_790_870_135, hit_ratio: 0.8757, misses: 0 },
	rate_limits: { five_hour: { used_percentage: 35, resets_at: 1_790_875_000 } },
};

describe("parseClaudeSessionStats", () => {
	it("extracts model, context, cache and cost from a statusLine payload", () => {
		expect(parseClaudeSessionStats(PAYLOAD, "task-1", 1000)).toEqual({
			taskId: "task-1",
			taskTitle: null,
			taskSeq: null,
			projectName: null,
			capturedAt: 1000,
			model: "Opus 5.5 (1M context)",
			effort: "medium",
			sessionName: "Status view display options",
			thinking: true,
			contextPercent: 8,
			contextWindowSize: 1_000_000,
			totalTokens: 82_774,
			cacheReadTokens: 79_694,
			cacheWriteTokens: 3070,
			turnInputTokens: 2,
			turnOutputTokens: 8,
			cache: { warm: true, ttl: "1h", expiresAt: 1_790_870_135_000, hitRatio: 0.8757, misses: 0 },
			costUsd: 0.657,
			durationMs: 62_816,
			apiDurationMs: 40_044,
			linesAdded: 3,
			linesRemoved: 1,
		});
	});

	it("returns null for a payload with neither model nor context window", () => {
		expect(parseClaudeSessionStats({ rate_limits: {} }, "t", 1)).toBeNull();
		expect(parseClaudeSessionStats("nope", "t", 1)).toBeNull();
	});

	it("leaves missing sections null before the first API response", () => {
		const stats = parseClaudeSessionStats({ model: { display_name: "Sonnet" } }, "t", 1);
		expect(stats?.cache).toBeNull();
		expect(stats?.totalTokens).toBeNull();
		expect(stats?.costUsd).toBeNull();
		expect(stats?.thinking).toBeNull();
		expect(stats?.sessionName).toBeNull();
	});
});

describe("isSessionCacheWarm", () => {
	it("treats a warm cache past its expiry as cold", () => {
		const cache = { warm: true, ttl: "5m", expiresAt: 10_000, hitRatio: null, misses: null };
		expect(isSessionCacheWarm(cache, 9_000)).toBe(true);
		expect(isSessionCacheWarm(cache, 10_001)).toBe(false);
		expect(isSessionCacheWarm({ ...cache, warm: false }, 0)).toBe(false);
	});
});

const NOW = 1_790_866_000_000;

function stats(taskId: string, overrides: Partial<ClaudeSessionStats> = {}): ClaudeSessionStats {
	return {
		...parseClaudeSessionStats({ model: { display_name: "Opus" } }, taskId, NOW - 60_000)!,
		taskTitle: taskId,
		...overrides,
	};
}

const warmFor = (ms: number) => ({ warm: true, ttl: "5m", expiresAt: NOW + ms, hitRatio: null, misses: null });

describe("sessionAttention", () => {
	it("flags an expiring warm cache only while the task waits on the user", () => {
		expect(sessionAttention(stats("a", { awaitingUser: true, cache: warmFor(120_000) }), NOW)).toBe("cacheExpiring");
		// A working agent refreshes its own 5m cache, so it is always "about to expire".
		expect(sessionAttention(stats("a", { awaitingUser: false, cache: warmFor(120_000) }), NOW)).toBeNull();
	});

	it("ignores caches far from expiry or already cold", () => {
		expect(sessionAttention(stats("a", { awaitingUser: true, cache: warmFor(30 * 60_000) }), NOW)).toBeNull();
		expect(sessionAttention(stats("a", { awaitingUser: true, cache: warmFor(-1) }), NOW)).toBeNull();
	});

	it("flags context at 85% and above", () => {
		expect(sessionAttention(stats("a", { contextPercent: 85 }), NOW)).toBe("context");
		expect(sessionAttention(stats("a", { contextPercent: 84 }), NOW)).toBeNull();
	});
});

describe("attentionSessions", () => {
	it("puts the soonest expiry first, then the fullest context, and caps the strip", () => {
		const list = [
			stats("ctx-90", { contextPercent: 90 }),
			stats("cache-4m", { awaitingUser: true, cache: warmFor(4 * 60_000) }),
			stats("ctx-95", { contextPercent: 95 }),
			stats("cache-1m", { awaitingUser: true, cache: warmFor(60_000) }),
			stats("calm", { contextPercent: 10 }),
		];
		const out = attentionSessions(list, NOW);
		expect(out).toHaveLength(MAX_ATTENTION_SESSIONS);
		expect(out.map((s) => s.taskId)).toEqual(["cache-1m", "cache-4m", "ctx-95"]);
	});
});

describe("summarizeSessions", () => {
	it("counts warm caches and sums reported costs", () => {
		const out = summarizeSessions(
			[stats("a", { costUsd: 1.5, cache: warmFor(60_000) }), stats("b", { costUsd: 0.25 }), stats("c")],
			NOW,
		);
		expect(out).toEqual({ count: 3, warm: 1, costUsd: 1.75 });
		expect(summarizeSessions([stats("a")], NOW).costUsd).toBeNull();
	});
});

describe("sortSessions", () => {
	it("sorts by cost either way and keeps missing values last", () => {
		const list = [stats("cheap", { costUsd: 1 }), stats("none"), stats("dear", { costUsd: 9 })];
		expect(sortSessions(list, "cost", "desc", NOW).map((s) => s.taskId)).toEqual(["dear", "cheap", "none"]);
		expect(sortSessions(list, "cost", "asc", NOW).map((s) => s.taskId)).toEqual(["cheap", "dear", "none"]);
	});

	it("orders cache by expiry, with cold caches last", () => {
		const list = [stats("cold"), stats("later", { cache: warmFor(50 * 60_000) }), stats("soon", { cache: warmFor(60_000) })];
		expect(sortSessions(list, "cache", "asc", NOW).map((s) => s.taskId)).toEqual(["soon", "later", "cold"]);
	});

	it("puts sessions needing attention first under the attention sort", () => {
		const list = [stats("calm"), stats("full", { contextPercent: 92 }), stats("cache", { awaitingUser: true, cache: warmFor(60_000) })];
		expect(sortSessions(list, "attention", "asc", NOW).map((s) => s.taskId)).toEqual(["cache", "full", "calm"]);
	});

	it("does not mutate its input", () => {
		const list = [stats("b", { costUsd: 1 }), stats("a", { costUsd: 2 })];
		sortSessions(list, "cost", "desc", NOW);
		expect(list.map((s) => s.taskId)).toEqual(["b", "a"]);
	});
});

describe("formatters", () => {
	it("formats tokens, cost and duration compactly", () => {
		expect(formatTokenCount(950)).toBe("950");
		expect(formatTokenCount(79_694)).toBe("79.7k");
		expect(formatTokenCount(1_250_000)).toBe("1.3M");
		expect(formatCostUsd(0.0042)).toBe("$0.0042");
		expect(formatCostUsd(0.657)).toBe("$0.657");
		expect(formatCostUsd(12.5)).toBe("$12.50");
		expect(formatDurationMs(45_000)).toBe("45s");
		expect(formatDurationMs(62_816)).toBe("1m");
		expect(formatDurationMs(7_500_000)).toBe("2h5m");
	});
});
