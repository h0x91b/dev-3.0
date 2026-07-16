import { describe, expect, it } from "vitest";
import {
	extractCodexSnapshotFromRolloutLines,
	formatResetDelta,
	formatStatusLineSegment,
	isRateLimitSnapshotRecent,
	isUnlimitedRateLimitSnapshot,
	latestRateLimitSnapshot,
	mergeCodexRateLimitSnapshots,
	parseClaudeStatusLinePayload,
	parseCodexAppServerRateLimits,
	parseCodexRateLimits,
	RATE_LIMIT_ACTIVITY_WINDOW_MS,
	rateLimitActivityAt,
	windowLabel,
	worstSnapshotWindow,
	worstWindow,
} from "../../shared/rate-limits";

const NOW = 1_783_200_000_000; // fixed epoch ms

describe("parseClaudeStatusLinePayload", () => {
	const payload = {
		session_id: "s",
		rate_limits: {
			five_hour: { used_percentage: 12, resets_at: 1_783_246_800 },
			seven_day: { used_percentage: 77.4, resets_at: 1_783_508_400 },
		},
	};

	it("parses both windows and converts resets_at to ms", () => {
		const snap = parseClaudeStatusLinePayload(payload, NOW);
		expect(snap).not.toBeNull();
		expect(snap!.source).toBe("claude");
		expect(snap!.capturedAt).toBe(NOW);
		expect(snap!.activeAt).toBe(NOW);
		expect(snap!.windows).toHaveLength(2);
		expect(snap!.windows[0]).toEqual({ id: "five_hour", usedPercent: 12, resetsAt: 1_783_246_800_000, windowMinutes: 300 });
		expect(snap!.windows[1].usedPercent).toBe(77.4);
	});

	it("returns null when rate_limits is absent (older Claude Code)", () => {
		expect(parseClaudeStatusLinePayload({ session_id: "s" }, NOW)).toBeNull();
		expect(parseClaudeStatusLinePayload(null, NOW)).toBeNull();
		expect(parseClaudeStatusLinePayload("garbage", NOW)).toBeNull();
	});

	it("parses a single window when only five_hour is present", () => {
		const snap = parseClaudeStatusLinePayload({ rate_limits: { five_hour: { used_percentage: 3 } } }, NOW);
		expect(snap!.windows).toHaveLength(1);
		expect(snap!.windows[0].resetsAt).toBeNull();
	});
});

describe("parseCodexRateLimits", () => {
	it("handles the enterprise usage-based shape (null windows, credits only)", () => {
		const snap = parseCodexRateLimits(
			{
				limit_id: "codex",
				primary: null,
				secondary: null,
				credits: { has_credits: true, unlimited: false, balance: "42.5" },
				plan_type: "enterprise_cbp_usage_based",
			},
			NOW,
		);
		expect(snap).not.toBeNull();
		expect(snap!.windows).toHaveLength(0);
		expect(snap!.creditsBalance).toBe("42.5");
		expect(snap!.planType).toBe("enterprise_cbp_usage_based");
	});

	it("parses absolute resets_at windows (newer Codex)", () => {
		const snap = parseCodexRateLimits(
			{ primary: { used_percent: 55.5, window_minutes: 300, resets_at: 1_783_250_000 } },
			NOW,
		);
		expect(snap!.windows[0]).toEqual({ id: "primary", usedPercent: 55.5, resetsAt: 1_783_250_000_000, windowMinutes: 300 });
	});

	it("anchors relative resets_in_seconds to the event time (older Codex)", () => {
		const snap = parseCodexRateLimits(
			{ secondary: { used_percent: 10, window_minutes: 10080, resets_in_seconds: 3600 } },
			NOW,
		);
		expect(snap!.windows[0].resetsAt).toBe(NOW + 3_600_000);
	});

	it("returns null for empty/garbage objects", () => {
		expect(parseCodexRateLimits({ primary: null, secondary: null, credits: { has_credits: false } }, NOW)).toBeNull();
		expect(parseCodexRateLimits(null, NOW)).toBeNull();
	});
});

describe("parseCodexAppServerRateLimits", () => {
	it("parses the live monthly individual credit limit and makes it a constraint", () => {
		const snap = parseCodexAppServerRateLimits(
			{
				limitId: "codex",
				primary: null,
				secondary: null,
				credits: { hasCredits: true, unlimited: false, balance: null },
				individualLimit: { limit: "8824", used: "329.5322287082672", remainingPercent: 96, resetsAt: 1_785_542_400 },
				planType: "enterprise_cbp_usage_based",
			},
			NOW,
		);

		expect(snap?.monthlyCredits).toEqual({ limit: 8824, used: 329.5322287082672, remainingPercent: 96, resetsAt: 1_785_542_400_000 });
		expect(snap?.windows).toContainEqual({ id: "monthly_credits", usedPercent: 4, resetsAt: 1_785_542_400_000, windowMinutes: null });
	});

	it("returns null when the live response carries no usable limit data", () => {
		expect(parseCodexAppServerRateLimits({ individualLimit: null, primary: null, secondary: null }, NOW)).toBeNull();
		expect(parseCodexAppServerRateLimits(null, NOW)).toBeNull();
	});
});

describe("mergeCodexRateLimitSnapshots", () => {
	it("adds live monthly credits while retaining rollout windows as fallback", () => {
		const rollout = parseCodexRateLimits({ primary: { used_percent: 55, window_minutes: 300 } }, NOW)!;
		const live = parseCodexAppServerRateLimits(
			{ individualLimit: { limit: "1000", used: "250", remainingPercent: 75, resetsAt: 1_785_542_400 } },
			NOW + 1000,
		)!;

		const merged = mergeCodexRateLimitSnapshots(rollout, live);
		expect(merged?.windows.map((window) => window.id)).toEqual(["primary", "monthly_credits"]);
		expect(merged?.monthlyCredits?.used).toBe(250);
		expect(merged?.capturedAt).toBe(NOW + 1000);
	});
});

describe("extractCodexSnapshotFromRolloutLines", () => {
	const event = (ts: string, percent: number) =>
		JSON.stringify({
			timestamp: ts,
			type: "event_msg",
			payload: { type: "token_count", rate_limits: { primary: { used_percent: percent, window_minutes: 300 } } },
		});

	it("returns the LAST rate_limits event in the file", () => {
		const lines = [event("2026-07-05T10:00:00Z", 10), '{"type":"other"}', event("2026-07-05T11:00:00Z", 42)];
		const snap = extractCodexSnapshotFromRolloutLines(lines);
		expect(snap!.windows[0].usedPercent).toBe(42);
		expect(snap!.capturedAt).toBe(Date.parse("2026-07-05T11:00:00Z"));
	});

	it("skips a torn trailing line and falls back to the previous event", () => {
		const lines = [event("2026-07-05T10:00:00Z", 10), '{"timestamp":"2026-07-05T11:00:00Z","payload":{"rate_limits":{"pri'];
		expect(extractCodexSnapshotFromRolloutLines(lines)!.windows[0].usedPercent).toBe(10);
	});

	it("returns null when no event carries rate limits", () => {
		expect(extractCodexSnapshotFromRolloutLines(['{"type":"other"}', ""])).toBeNull();
	});
});

describe("formatResetDelta", () => {
	it("formats minutes, hours and days", () => {
		expect(formatResetDelta(NOW + 42 * 60_000, NOW)).toBe("42m");
		expect(formatResetDelta(NOW + (2 * 60 + 13) * 60_000, NOW)).toBe("2h13m");
		expect(formatResetDelta(NOW + (3 * 24 + 2) * 3_600_000, NOW)).toBe("3d2h");
	});

	it("returns empty for unknown or past resets", () => {
		expect(formatResetDelta(null, NOW)).toBe("");
		expect(formatResetDelta(NOW - 1000, NOW)).toBe("");
	});
});

describe("rate-limit activity freshness", () => {
	it("uses the provider activity timestamp when live data was captured later", () => {
		const snapshot = parseCodexRateLimits({ primary: { used_percent: 42 } }, NOW)!;
		snapshot.capturedAt = NOW + 10 * 60_000;
		snapshot.activeAt = NOW;

		expect(rateLimitActivityAt(snapshot)).toBe(NOW);
		expect(isRateLimitSnapshotRecent(snapshot, NOW + RATE_LIMIT_ACTIVITY_WINDOW_MS - 1)).toBe(true);
		expect(isRateLimitSnapshotRecent(snapshot, NOW + RATE_LIMIT_ACTIVITY_WINDOW_MS + 1)).toBe(false);
	});

	it("selects the snapshot with the newest provider activity", () => {
		const older = parseClaudeStatusLinePayload({ rate_limits: { five_hour: { used_percentage: 100 } } }, NOW)!;
		const latest = parseCodexRateLimits({ primary: { used_percent: 24 } }, NOW + 1_000)!;
		latest.capturedAt = NOW + 10_000;

		expect(latestRateLimitSnapshot({ generatedAt: NOW + 10_000, snapshots: [older, latest] })).toBe(latest);
		expect(worstSnapshotWindow(latest)?.usedPercent).toBe(24);
	});

	it("recognizes an unlimited credits snapshot", () => {
		const unlimited = parseCodexRateLimits({ credits: { has_credits: true, unlimited: true } }, NOW)!;
		expect(isUnlimitedRateLimitSnapshot(unlimited)).toBe(true);
	});
});

describe("windowLabel", () => {
	it("maps ids and codex window minutes to compact labels", () => {
		expect(windowLabel({ id: "five_hour", usedPercent: 0, resetsAt: null, windowMinutes: 300 })).toBe("5h");
		expect(windowLabel({ id: "seven_day", usedPercent: 0, resetsAt: null, windowMinutes: 10080 })).toBe("7d");
		expect(windowLabel({ id: "primary", usedPercent: 0, resetsAt: null, windowMinutes: 300 })).toBe("5h");
		expect(windowLabel({ id: "secondary", usedPercent: 0, resetsAt: null, windowMinutes: 10080 })).toBe("7d");
		expect(windowLabel({ id: "primary", usedPercent: 0, resetsAt: null, windowMinutes: null })).toBe("primary");
	});
});

describe("worstWindow", () => {
	it("picks the most-used window across snapshots", () => {
		const report = {
			generatedAt: NOW,
			snapshots: [
				parseClaudeStatusLinePayload({ rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 77 } } }, NOW)!,
				parseCodexRateLimits({ primary: { used_percent: 50 } }, NOW)!,
			],
		};
		const worst = worstWindow(report);
		expect(worst!.source).toBe("claude");
		expect(worst!.window.id).toBe("seven_day");
	});

	it("returns null when no snapshot has windows", () => {
		expect(worstWindow({ generatedAt: NOW, snapshots: [] })).toBeNull();
	});

	it("lets a nearly exhausted monthly credit limit drive the indicator", () => {
		const monthly = parseCodexAppServerRateLimits(
			{ individualLimit: { limit: "1000", used: "970", remainingPercent: 3, resetsAt: 1_785_542_400 } },
			NOW,
		)!;
		const worst = worstWindow({ generatedAt: NOW, snapshots: [monthly] });
		expect(worst?.window.id).toBe("monthly_credits");
		expect(worst?.window.usedPercent).toBe(97);
	});
});

describe("formatStatusLineSegment", () => {
	const snap = (pct5: number, pct7: number) =>
		parseClaudeStatusLinePayload(
			{ rate_limits: { five_hour: { used_percentage: pct5, resets_at: (NOW + 3_600_000) / 1000 }, seven_day: { used_percentage: pct7 } } },
			NOW,
		);

	it("renders both windows with percent and reset delta", () => {
		const seg = formatStatusLineSegment(snap(12, 77), NOW);
		expect(seg).toContain("5h 12% ↻1h");
		expect(seg).toContain("7d 77%");
	});

	it("uses warning color at ≥80% and danger at ≥95%", () => {
		expect(formatStatusLineSegment(snap(81, 10), NOW)).toContain("\x1b[33m5h 81%");
		expect(formatStatusLineSegment(snap(96, 10), NOW)).toContain("\x1b[31m5h 96%");
		expect(formatStatusLineSegment(snap(12, 10), NOW)).toContain("\x1b[90m5h 12%");
	});

	it("returns empty for null/empty snapshots", () => {
		expect(formatStatusLineSegment(null, NOW)).toBe("");
	});
});
