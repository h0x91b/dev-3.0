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
import type { AgentAccount, AgentAccountIdentity, AgentAccountsState } from "../../shared/agent-accounts";
import { codexLoginKey, managedCodexTwin } from "../../shared/agent-accounts";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../../shared/rate-limits";

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

	it("a burst with no readings at all still spreads over the logins", () => {
		expect(batch([acc("C", null), acc("D", null)], 4)).toEqual(["C", "D", "C", "D"]);
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

	it("reservations alone never make an account hot or defer a burst to the reset", () => {
		const accounts = [acc("A", { s: 80, w: 40, sResetH: 4 }), acc("B", { s: 80, w: 40, sResetH: 4 })];
		const reservations: AccountReservation[] = ["A", "A", "B", "B"].map((id) => ({ accountId: id, at: NOW, short: 6, weekly: 1 }));
		const r = routeAccount({ accounts, reservations, now: NOW });
		expect(r.picked).toBe(true);
		expect(r.assessed.map((a) => a.status)).toEqual(["eligible", "eligible"]);
		expect(r.assessed[0].shortEff).toBe(92);
		const nearFloor = [acc("W", { s: 10, w: 94 })];
		const weekly: AccountReservation[] = [0, 1, 2].map(() => ({ accountId: "W", at: NOW, short: 6, weekly: 1 }));
		expect(routeAccount({ accounts: nearFloor, reservations: weekly, now: NOW }).picked).toBe(true);
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
		codex: { accounts, activeId: null, currentIdentity: { email: "a@x", organization: null, plan: "plus", planLabel: "Plus", accountId: "ws-a" } },
		omp: { accounts: [], activeId: null },
			pi: { accounts: [], activeId: null },
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

describe("Codex login identity (#1964)", () => {
	const identity = (extra: Partial<AgentAccountIdentity> = {}): AgentAccountIdentity => ({
		email: "dana@example.test",
		organization: null,
		plan: "team",
		planLabel: "Team",
		accountId: "ws-1",
		userId: "user-dana",
		...extra,
	});
	const codexAccount = (id: string, ident: AgentAccountIdentity): AgentAccount => ({
		id,
		kind: "codex",
		label: id,
		identity: ident,
		auth: "oauth",
		api: null,
		createdAt: 0,
	});
	const codexState = (accounts: AgentAccount[], current: AgentAccountIdentity | null): AgentAccountsState => ({
		claude: { accounts: [], activeId: null, systemConfigDir: "/h/.claude", systemIdentity: null },
		codex: { accounts, activeId: accounts[0]?.id ?? null, currentIdentity: current },
		omp: { accounts: [], activeId: null },
		pi: { accounts: [], activeId: null },
	});

	it("keys a login by workspace and person, preferring chatgpt_user_id over email", () => {
		expect(codexLoginKey(identity())).toBe("ws-1|user:user-dana");
		expect(codexLoginKey(identity({ userId: undefined, email: "Dana@Example.test" }))).toBe("ws-1|email:dana@example.test");
		expect(codexLoginKey(identity({ userId: undefined, email: null }))).toBeNull();
		expect(codexLoginKey(identity({ accountId: null }))).toBeNull();
	});

	it("finds the managed twin of ~/.codex only for the same person in the same workspace", () => {
		const managed = codexAccount("m", identity());
		expect(managedCodexTwin(codexState([managed], identity({ email: "other-case@example.test" })))?.id).toBe("m");
		expect(managedCodexTwin(codexState([managed], identity({ userId: "user-lee", email: "lee@example.test" })))).toBeNull();
		expect(managedCodexTwin(codexState([managed], identity({ accountId: "ws-2" })))).toBeNull();
		expect(managedCodexTwin(codexState([managed], identity({ userId: undefined, email: null })))).toBeNull();
		expect(managedCodexTwin(codexState([managed], null))).toBeNull();
	});

	it("never pairs logins across workspaces or people that share an email", () => {
		const managed = codexAccount("m", identity());
		// Same email, other workspace: a different account, even for one person.
		expect(managedCodexTwin(codexState([managed], identity({ accountId: "ws-2" })))).toBeNull();
		// Same email and workspace, other chatgpt_user_id: the person id wins over the email.
		expect(managedCodexTwin(codexState([managed], identity({ userId: "user-other" })))).toBeNull();
		// Person id on one side only: keys cannot be compared, so no merge (conservative).
		expect(managedCodexTwin(codexState([managed], identity({ userId: undefined })))).toBeNull();
		// Email-only on both sides still pairs, case-insensitively.
		const emailOnly = codexAccount("e", identity({ userId: undefined }));
		expect(managedCodexTwin(codexState([emailOnly], identity({ userId: undefined, email: "DANA@example.test" })))?.id).toBe("e");
	});

	it("picks the matching managed account when several are registered", () => {
		const other = codexAccount("o", identity({ accountId: "ws-2" }));
		const mine = codexAccount("m", identity());
		expect(managedCodexTwin(codexState([other, mine], identity()))?.id).toBe("m");
	});

	it("routes on the fresher reading of a twin and counts it as one login", () => {
		const own: AgentRateLimitSnapshot = { ...snap({ s: 10 }), source: "codex", accountId: "m", capturedAt: NOW - 3_600_000 };
		const viaDefault: AgentRateLimitSnapshot = { ...snap({ s: 60 }), source: "codex", accountId: null, capturedAt: NOW };
		const report: AgentRateLimitsReport = { generatedAt: NOW, snapshots: [own, viaDefault] };
		const list = buildRoutableAccounts("codex", codexState([codexAccount("m", identity())], identity()), report);
		expect(list[0].snapshot).toBe(viaDefault);
		expect(autoCandidateCount(list)).toBe(1);
	});

	it("counts another seat of the same workspace as a separate login", () => {
		const list = buildRoutableAccounts("codex", codexState([codexAccount("m", identity())], identity({ userId: "user-lee", email: "lee@example.test" })), null);
		expect(autoCandidateCount(list)).toBe(2);
	});
});
