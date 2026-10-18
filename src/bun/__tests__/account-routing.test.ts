import { describe, expect, it } from "vitest";
import {
	autoCandidateCount,
	buildRoutableAccounts,
	classifyWindows,
	reservedLoad,
	routeAccount,
	type AccountReservation,
	type RoutableAccount,
} from "../../shared/account-routing";
import type { AgentAccount, AgentAccountsState } from "../../shared/agent-accounts";
import type { AgentRateLimitSnapshot } from "../../shared/rate-limits";

const NOW = 1_783_200_000_000;
const H = 3_600_000;
const MIN = 60_000;

interface Reading {
	s?: number;
	sResetH?: number;
	w?: number;
	wResetH?: number;
	ageMin?: number;
	source?: "claude" | "codex";
	shortMinutes?: number;
	longMinutes?: number;
}

function snap({ s = 0, sResetH = 3, w, wResetH = 96, ageMin = 1, source = "claude", shortMinutes = 300, longMinutes = 10080 }: Reading): AgentRateLimitSnapshot {
	const windows = [{ id: source === "claude" ? "five_hour" : "primary", usedPercent: s, resetsAt: NOW + sResetH * H, windowMinutes: shortMinutes }];
	if (w != null) windows.push({ id: source === "claude" ? "seven_day" : "secondary", usedPercent: w, resetsAt: NOW + wResetH * H, windowMinutes: longMinutes });
	return { source, capturedAt: NOW - ageMin * MIN, windows, creditsBalance: null, monthlyCredits: null, planType: null };
}

function acc(id: string, reading: Reading | null, extra: Partial<RoutableAccount> = {}): RoutableAccount {
	return { id, label: id, metered: false, excluded: false, dedupeKey: id, snapshot: reading ? snap(reading) : null, ...extra };
}

/** A batch of launches, reserving after each pick exactly like the bun router. */
function batch(accounts: RoutableAccount[], n: number): (string | null)[] {
	const reservations: AccountReservation[] = [];
	const picks: (string | null)[] = [];
	for (let i = 0; i < n; i++) {
		const r = routeAccount({ accounts, reservations, now: NOW });
		picks.push(r.picked ? r.accountId : "none");
		if (!r.picked) break;
		const short = r.accountId === "P" ? 12 : r.accountId === "M" ? 3 : 6;
		reservations.push({ accountId: r.accountId, at: NOW, short, weekly: 1 });
	}
	return picks;
}

describe("routeAccount — the design scenarios", () => {
	it("s1: a much lower short window wins even when the other week resets sooner", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 70, w: 40, wResetH: 24 }), acc("B", { s: 30, w: 40, wResetH: 96 })], now: NOW });
		expect(r.accountId).toBe("B");
		expect(r.reason).toEqual({ code: "lowest-short", short: 30, nextShort: 70 });
	});

	it("s2: comparable short windows → the weekly quota that expires sooner", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 20, w: 50, wResetH: 24 }), acc("B", { s: 25, w: 50, wResetH: 96 })], now: NOW });
		expect(r.accountId).toBe("A");
		expect(r.reason.code).toBe("pace");
	});

	it("s3: a reset-soon week that is nearly spent loses to a roomy one", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 15, w: 80, wResetH: 72 }), acc("B", { s: 20, w: 30, wResetH: 120 })], now: NOW });
		expect(r.accountId).toBe("B");
	});

	it("s4: an exhausted week is out despite a quiet short window", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 5, w: 97, wResetH: 60 }), acc("B", { s: 45, w: 30, wResetH: 100 })], now: NOW });
		expect(r.accountId).toBe("B");
		expect(r.assessed[0].status).toBe("weekly-floor");
	});

	it("s5: a stale reading drifts upwards and loses the tie", () => {
		const r = routeAccount({
			accounts: [acc("A", { s: 10, sResetH: 1.5, w: 40, wResetH: 80, ageMin: 180 }), acc("B", { s: 28, w: 40, wResetH: 80 })],
			now: NOW,
		});
		expect(r.assessed[0].stale).toBe(true);
		expect(r.assessed[0].shortEff).toBeCloseTo(35);
		expect(r.accountId).toBe("B");
	});

	it("s6: a short window whose reset has passed counts as nearly empty", () => {
		const r = routeAccount({
			accounts: [acc("A", { s: 85, sResetH: -0.3, w: 45, wResetH: 70, ageMin: 90 }), acc("B", { s: 40, w: 45, wResetH: 70 })],
			now: NOW,
		});
		expect(r.accountId).toBe("A");
		expect(r.assessed[0].shortEff).toBe(10);
	});

	it("s7: a never-read account waits until every known one is past comfort", () => {
		expect(routeAccount({ accounts: [acc("B", { s: 45, w: 30 }), acc("C", null)], now: NOW }).accountId).toBe("B");
		const busy = routeAccount({ accounts: [acc("B", { s: 75, w: 30 }), acc("C", null)], now: NOW });
		expect(busy.accountId).toBe("C");
		expect(busy.reason.code).toBe("unknown");
	});

	it("s8: unlimited is the overflow tier; limit-less readings never route", () => {
		const unlimited: RoutableAccount = { ...acc("E", null), snapshot: { ...snap({ source: "codex" }), windows: [], creditsBalance: "unlimited" } };
		const silent: RoutableAccount = { ...acc("U", null), snapshot: { ...snap({}), windows: [] } };
		const r = routeAccount({ accounts: [acc("A", { s: 70, w: 50 }), unlimited, silent], now: NOW });
		expect(r.accountId).toBe("E");
		expect(r.reason.code).toBe("unlimited");
		expect(r.assessed[2].status).toBe("no-limits");
		expect(routeAccount({ accounts: [acc("A", { s: 30, w: 50 }), unlimited], now: NOW }).accountId).toBe("A");
	});

	it("s9: per-account reservation size spreads a batch by real capacity", () => {
		expect(batch([acc("P", { s: 30, w: 40, wResetH: 90 }), acc("M", { s: 35, w: 40, wResetH: 90 })], 4)).toEqual(["P", "M", "M", "M"]);
	});

	it("s10: reservations keep a batch from piling onto one account", () => {
		const accounts = [acc("A", { s: 20, w: 40, wResetH: 60 }), acc("B", { s: 22, w: 40, wResetH: 110 }), acc("C", { s: 40, w: 20, wResetH: 30 })];
		const picks = batch(accounts, 5);
		expect(new Set(picks).size).toBeGreaterThan(1);
		expect(picks).toEqual(["A", "A", "A", "B", "A"]);
	});

	it("s11: nothing eligible → no pick, earliest blocking reset, never the metered one", () => {
		const r = routeAccount({
			accounts: [
				acc("A", { s: 93, sResetH: 1.2, w: 60, wResetH: 50 }),
				acc("B", { s: 10, w: 30 }, { excluded: true }),
				acc("K", null, { metered: true }),
			],
			now: NOW,
		});
		expect(r.picked).toBe(false);
		expect(r.reason).toEqual({ code: "none", earliestResetAt: NOW + 1.2 * H });
		expect(r.assessed.map((a) => a.status)).toEqual(["hot", "excluded", "metered"]);
	});

	it("s12: an excluded account is skipped even when it is the emptiest", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 35, w: 50 }), acc("B", { s: 20, w: 40 }, { excluded: true })], now: NOW });
		expect(r.accountId).toBe("A");
		expect(r.reason.code).toBe("only");
	});

	it("s13: weekly pressure never overrides a short-window gap wider than the band", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 40, w: 30, wResetH: 12 }), acc("B", { s: 20, w: 50, wResetH: 120 })], now: NOW });
		expect(r.accountId).toBe("B");
	});
});

describe("routeAccount — edges", () => {
	it("classifies windows by real length, so a 60-minute Codex primary is the short one", () => {
		const s = snap({ source: "codex", s: 40, w: 10, shortMinutes: 60, longMinutes: 1440 });
		const { short, long } = classifyWindows({ ...s, windows: [...s.windows].reverse() });
		expect(short?.windowMinutes).toBe(60);
		expect(long?.windowMinutes).toBe(1440);
	});

	it("a single timed window gives a neutral pace", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 20 }), acc("B", { s: 22 })], now: NOW });
		expect(r.assessed.map((a) => a.pace)).toEqual([1, 1]);
		expect(r.accountId).toBe("A");
		expect(r.reason.code).toBe("tie-short");
	});

	it("applies hysteresis at the hot edge: out at 90, back only at 85", () => {
		const step = (s: number, cooling?: Set<string>) =>
			routeAccount({ accounts: [acc("A", { s, w: 10 }), acc("Z", { s: 95, w: 10 })], now: NOW, cooling });
		const r89 = step(89);
		expect(r89.accountId).toBe("A");
		const r91 = step(91, r89.cooling);
		expect(r91.picked).toBe(false);
		const r87 = step(87, r91.cooling);
		expect(r87.picked).toBe(false);
		expect(step(84, r87.cooling).accountId).toBe("A");
	});

	it("treats two logins with one provider identity as one quota", () => {
		const r = routeAccount({ accounts: [acc("A", { s: 50, w: 10 }, { dedupeKey: "same" }), acc("B", { s: 5, w: 10 }, { dedupeKey: "same" })], now: NOW });
		expect(r.accountId).toBe("A");
		expect(r.assessed[1].status).toBe("duplicate");
	});

	it("never picks a gateway spend-limited login", () => {
		const gateway: RoutableAccount = { ...acc("G", { s: 0, w: 0 }), snapshot: { ...snap({ s: 0 }), spendLimit: { usedUsd: 1, limitUsd: 10, period: "daily" } } };
		expect(routeAccount({ accounts: [gateway], now: NOW }).picked).toBe(false);
	});

	it("decays a reservation linearly over its lifetime", () => {
		const reservations = [{ accountId: "A", at: NOW, short: 6, weekly: 1 }];
		const ms = 20 * MIN;
		expect(reservedLoad(reservations, "A", NOW, ms).short).toBe(6);
		expect(reservedLoad(reservations, "A", NOW + 10 * MIN, ms).short).toBeCloseTo(3);
		expect(reservedLoad(reservations, "A", NOW + 20 * MIN, ms).count).toBe(0);
		expect(reservedLoad(reservations, null, NOW, ms).count).toBe(0);
	});
});

describe("buildRoutableAccounts", () => {
	const account = (id: string, extra: Partial<AgentAccount> = {}): AgentAccount => ({
		id,
		kind: "codex",
		label: id,
		identity: { email: `${id}@x`, organization: null, plan: "plus", planLabel: "Plus", accountId: `ws-${id}` },
		auth: "oauth",
		api: null,
		createdAt: 0,
		...extra,
	});
	const state = (accounts: AgentAccount[]): AgentAccountsState => ({
		claude: { accounts: [], activeId: null, systemConfigDir: "/h/.claude", systemIdentity: null },
		codex: { accounts, activeId: null, currentIdentity: { email: "me@x", organization: null, plan: "plus", planLabel: "Plus", accountId: "ws-a" } },
		omp: { accounts: [], activeId: null },
	});

	it("marks usage-based plans metered, applies exclusions, and appends the system login", () => {
		const usage = account("b", { identity: { email: null, organization: null, plan: "enterprise_cbp_usage_based", planLabel: "Enterprise", accountId: "ws-b" } });
		const list = buildRoutableAccounts("codex", state([account("a"), usage, account("c")]), null, ["c", "system:codex"]);
		expect(list.map((a) => [a.id, a.metered, a.excluded])).toEqual([
			["a", false, false],
			["b", true, false],
			["c", false, true],
			[null, false, true],
		]);
		expect(autoCandidateCount(list)).toBe(1);
	});

	it("counts a system login sharing a managed identity once", () => {
		expect(autoCandidateCount(buildRoutableAccounts("codex", state([account("a"), account("d")]), null))).toBe(2);
	});
});
