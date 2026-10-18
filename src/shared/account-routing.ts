/**
 * Usage-balanced "Auto" account routing — the pure decision. Given every
 * subscription login of one harness, its last limit reading, and the launches
 * this router already started, pick the account a fresh launch should use.
 *
 * Algorithm (decisions/2026/10/18/usage-balanced-auto-account-routing.md):
 *  1. Hard filters: metered (API / usage-based) logins, project exclusions,
 *     duplicate identities, limit-less readings, a hot short window or an
 *     exhausted weekly one never route.
 *  2. Band: every account whose effective short-window usage is within
 *     `band` pp of the lowest.
 *  3. Inside the band: highest weekly pace = headroom / share of the weekly
 *     window still left — the quota most at risk of expiring unused.
 * "Effective" usage is pessimistic: the measured % is a floor, a stale
 * reading drifts upwards, and recent launches add a decaying reservation.
 */
import type { AgentAccountIdentity, AgentAccountsState, RoutableAccountKind } from "./agent-accounts";
import {
	BUDGET_WINDOW_IDS,
	findRateLimitSnapshot,
	isUnlimitedRateLimitSnapshot,
	type AgentRateLimitSnapshot,
	type AgentRateLimitsReport,
	type RateLimitWindow,
} from "./rate-limits";

export const ROUTING_PARAMS = {
	/** pp: short-window usage this close to the lowest counts as comparable. */
	band: 10,
	/** pp: short window at or above this is out; back in at `hotReadmit`. */
	hot: 90,
	hotReadmit: 85,
	/** pp of weekly headroom below which the account is out; back in at `weeklyReadmit`. */
	weeklyFloor: 5,
	weeklyReadmit: 8,
	/** A reading older than this drifts (matches the UI's stale tint). */
	freshMs: 10 * 60 * 1000,
	staleShortPpPerHour: 10,
	staleShortCap: 25,
	staleWeeklyPpPerHour: 1,
	staleWeeklyCap: 5,
	/** pp assumed for a window that rolled over but has not been re-read. */
	resetFloor: 10,
	/** Unknown / unlimited logins are only used once no known one is below this. */
	comfort: 60,
	paceCap: 4,
	tauFloor: 0.02,
	paceTieEpsilon: 0.15,
	/** Predicted cost of one launch, decaying linearly over `reservationMs`. */
	reserveShort: 6,
	reserveWeekly: 1,
	reservationMs: 20 * 60 * 1000,
} as const;

export type RoutingParams = { [K in keyof typeof ROUTING_PARAMS]: number };

export interface RoutableAccount {
	/** Managed account id; null = the harness's own system login. */
	id: string | null;
	label: string;
	/** Pay-per-token or usage-based: never routed. */
	metered: boolean;
	/** Excluded from Auto for the launching project. */
	excluded: boolean;
	/** Provider identity; logins sharing one share a quota. Null = unknown. */
	dedupeKey: string | null;
	snapshot: AgentRateLimitSnapshot | null;
}

export interface AccountReservation {
	accountId: string | null;
	at: number;
	short: number;
	weekly: number;
}

export type AssessedStatus = "eligible" | "metered" | "excluded" | "duplicate" | "no-limits" | "hot" | "weekly-floor";
export type RoutingTier = "known" | "unlimited" | "unknown";

export interface AssessedAccount {
	id: string | null;
	label: string;
	status: AssessedStatus;
	tier: RoutingTier | null;
	/** Effective (pessimistic) short-window usage, pp. */
	shortEff: number | null;
	weeklyEff: number | null;
	pace: number | null;
	shortResetsAt: number | null;
	weeklyResetsAt: number | null;
	stale: boolean;
	/** Predicted pp still reserved by recent launches. */
	reservedShort: number;
	activeReservations: number;
}

export type AccountPickReason =
	| { code: "only"; short: number | null }
	| { code: "lowest-short"; short: number; nextShort: number }
	| { code: "pace"; short: number; pace: number; weeklyLeft: number; weeklyResetsAt: number | null }
	| { code: "tie-short"; short: number }
	| { code: "unlimited" }
	| { code: "unknown" }
	| { code: "none"; earliestResetAt: number | null };

export interface RoutingResult {
	picked: boolean;
	accountId: string | null;
	label: string | null;
	reason: AccountPickReason;
	assessed: AssessedAccount[];
	/** Hysteresis state to carry into the next call. */
	cooling: Set<string>;
}

export interface RoutingInput {
	accounts: RoutableAccount[];
	reservations?: AccountReservation[];
	now: number;
	cooling?: ReadonlySet<string>;
	params?: Partial<RoutingParams>;
}

interface WindowPair {
	short: RateLimitWindow | null;
	long: RateLimitWindow | null;
}

/** Timed windows only, shortest first: the shortest is the "short" window, the
 *  longest the "weekly" one. Codex reports real lengths, so nothing assumes 5h/7d. */
export function classifyWindows(snapshot: AgentRateLimitSnapshot): WindowPair {
	const timed = snapshot.windows
		.filter((w) => !BUDGET_WINDOW_IDS.has(w.id))
		.sort((a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY));
	return { short: timed[0] ?? null, long: timed.length > 1 ? timed[timed.length - 1] : null };
}

const coolKey = (id: string | null, which: "short" | "weekly") => `${id ?? "system"}:${which}`;
const sameId = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);

export function reservedLoad(
	reservations: AccountReservation[],
	accountId: string | null,
	now: number,
	reservationMs: number,
): { short: number; weekly: number; count: number } {
	let short = 0;
	let weekly = 0;
	let count = 0;
	for (const r of reservations) {
		if (!sameId(r.accountId, accountId)) continue;
		const left = 1 - (now - r.at) / reservationMs;
		if (left <= 0) continue;
		const share = Math.min(1, left);
		short += r.short * share;
		weekly += r.weekly * share;
		count++;
	}
	return { short, weekly, count };
}

function assess(
	acc: RoutableAccount,
	p: RoutingParams,
	now: number,
	reservations: AccountReservation[],
	cooling: ReadonlySet<string>,
	nextCooling: Set<string>,
): AssessedAccount {
	const load = reservedLoad(reservations, acc.id, now, p.reservationMs);
	const out: AssessedAccount = {
		id: acc.id,
		label: acc.label,
		status: "eligible",
		tier: null,
		shortEff: null,
		weeklyEff: null,
		pace: null,
		shortResetsAt: null,
		weeklyResetsAt: null,
		stale: false,
		reservedShort: load.short,
		activeReservations: load.count,
	};
	if (acc.metered) return { ...out, status: "metered" };
	if (acc.excluded) return { ...out, status: "excluded" };
	const snap = acc.snapshot;
	if (!snap) return { ...out, tier: "unknown" };
	if (isUnlimitedRateLimitSnapshot(snap)) return { ...out, tier: "unlimited" };
	if (snap.spendLimit) return { ...out, status: "metered" };
	const { short, long } = classifyWindows(snap);
	if (!short) return { ...out, status: "no-limits" };

	const ageHours = Math.max(0, now - snap.capturedAt) / 3_600_000;
	const stale = now - snap.capturedAt > p.freshMs;
	const shortReset = short.resetsAt != null && short.resetsAt <= now;
	let shortEff = shortReset ? p.resetFloor : short.usedPercent;
	if (!shortReset && stale) shortEff += Math.min(p.staleShortCap, p.staleShortPpPerHour * ageHours);
	shortEff = Math.min(100, shortEff + load.short);

	let weeklyEff: number | null = null;
	let tau = 1;
	let weeklyResetsAt: number | null = null;
	if (long) {
		const longReset = long.resetsAt != null && long.resetsAt <= now;
		weeklyEff = longReset ? p.resetFloor : long.usedPercent;
		if (!longReset && stale) weeklyEff += Math.min(p.staleWeeklyCap, p.staleWeeklyPpPerHour * ageHours);
		weeklyEff = Math.min(100, weeklyEff + load.weekly);
		if (!longReset && long.resetsAt != null && long.windowMinutes) {
			tau = Math.max(p.tauFloor, (long.resetsAt - now) / (long.windowMinutes * 60_000));
			weeklyResetsAt = long.resetsAt;
		}
	}
	const weeklyLeft = weeklyEff == null ? 100 : 100 - weeklyEff;
	const pace = weeklyEff == null ? 1 : Math.min(p.paceCap, weeklyLeft / 100 / tau);

	const assessed: AssessedAccount = {
		...out,
		tier: "known",
		shortEff,
		weeklyEff,
		pace,
		shortResetsAt: shortReset ? null : short.resetsAt,
		weeklyResetsAt,
		stale,
	};
	const shortCooling = cooling.has(coolKey(acc.id, "short")) && !shortReset;
	const hot = shortCooling ? shortEff > p.hotReadmit : shortEff >= p.hot;
	if (hot) nextCooling.add(coolKey(acc.id, "short"));
	const weeklyCooling = cooling.has(coolKey(acc.id, "weekly")) && weeklyResetsAt != null;
	const floor = weeklyEff != null && (weeklyCooling ? weeklyLeft < p.weeklyReadmit : weeklyLeft < p.weeklyFloor);
	if (floor) nextCooling.add(coolKey(acc.id, "weekly"));
	if (hot) return { ...assessed, status: "hot" };
	if (floor) return { ...assessed, status: "weekly-floor" };
	return assessed;
}

export function routeAccount(input: RoutingInput): RoutingResult {
	const p: RoutingParams = { ...ROUTING_PARAMS, ...input.params };
	const reservations = input.reservations ?? [];
	const cooling = input.cooling ?? new Set<string>();
	const nextCooling = new Set<string>();
	const seen = new Set<string>();
	const assessed = input.accounts.map((acc) => {
		if (acc.dedupeKey && !acc.metered) {
			if (seen.has(acc.dedupeKey)) {
				return { ...assess({ ...acc, snapshot: null }, p, input.now, [], cooling, new Set()), status: "duplicate" as const, tier: null };
			}
			seen.add(acc.dedupeKey);
		}
		return assess(acc, p, input.now, reservations, cooling, nextCooling);
	});
	const eligible = assessed.filter((a) => a.status === "eligible");
	const known = eligible.filter((a) => a.tier === "known");
	const unlimited = eligible.filter((a) => a.tier === "unlimited");
	const unknown = eligible.filter((a) => a.tier === "unknown");
	const done = (pick: AssessedAccount, reason: AccountPickReason): RoutingResult => ({
		picked: true,
		accountId: pick.id,
		label: pick.label,
		reason,
		assessed,
		cooling: nextCooling,
	});

	const comfortable = known.some((a) => (a.shortEff ?? 100) < p.comfort);
	if (known.length && (comfortable || (!unlimited.length && !unknown.length))) {
		const lowest = Math.min(...known.map((a) => a.shortEff as number));
		const band = known.filter((a) => (a.shortEff as number) <= lowest + p.band);
		const order = new Map(known.map((a, i) => [a, i]));
		band.sort((a, b) => {
			const dp = (b.pace as number) - (a.pace as number);
			if (Math.abs(dp) > p.paceTieEpsilon) return dp;
			return (
				(a.shortEff as number) - (b.shortEff as number) ||
				a.activeReservations - b.activeReservations ||
				(order.get(a) as number) - (order.get(b) as number)
			);
		});
		const pick = band[0];
		const short = pick.shortEff as number;
		if (known.length === 1) return done(pick, { code: "only", short });
		if (band.length === 1) {
			const nextShort = Math.min(...known.filter((a) => a !== pick).map((a) => a.shortEff as number));
			return done(pick, { code: "lowest-short", short, nextShort });
		}
		const rivalPace = Math.max(...band.filter((a) => a !== pick).map((a) => a.pace as number));
		if ((pick.pace as number) - rivalPace > p.paceTieEpsilon) {
			return done(pick, {
				code: "pace",
				short,
				pace: pick.pace as number,
				weeklyLeft: pick.weeklyEff == null ? 100 : 100 - pick.weeklyEff,
				weeklyResetsAt: pick.weeklyResetsAt,
			});
		}
		return done(pick, { code: "tie-short", short });
	}
	if (unlimited.length) return done(unlimited[0], { code: "unlimited" });
	if (unknown.length) return done(unknown[0], { code: "unknown" });

	const blockers = assessed
		.map((a) => (a.status === "hot" ? a.shortResetsAt : a.status === "weekly-floor" ? a.weeklyResetsAt : null))
		.filter((t): t is number => t != null && t > input.now);
	return {
		picked: false,
		accountId: null,
		label: null,
		reason: { code: "none", earliestResetAt: blockers.length ? Math.min(...blockers) : null },
		assessed,
		cooling: nextCooling,
	};
}

/** Exclusion-list key for a harness's own system login (managed logins use their id). */
export function systemLoginExclusionKey(kind: RoutableAccountKind): string {
	return `system:${kind}`;
}

export function exclusionKey(kind: RoutableAccountKind, accountId: string | null): string {
	return accountId ?? systemLoginExclusionKey(kind);
}

/** Usage-based ("enterprise_cbp_usage_based") plans bill per token. */
export function isMeteredPlan(plan: string | null | undefined): boolean {
	return !!plan && /usage[_-]?based/i.test(plan);
}

function dedupeKeyFor(kind: RoutableAccountKind, identity: AgentAccountIdentity | null): string | null {
	if (!identity?.accountId) return null;
	return kind === "claude" ? `${identity.accountId}|${identity.organization ?? ""}` : identity.accountId;
}

/**
 * Every login of one harness, in routing order: managed accounts (registry
 * order), then the system login when it is signed in. A system login that is
 * the same identity as a managed one is dropped by `routeAccount`'s dedupe.
 */
export function buildRoutableAccounts(
	kind: RoutableAccountKind,
	state: AgentAccountsState,
	report: AgentRateLimitsReport | null,
	exclusions: readonly string[] = [],
	systemLabel = "Default login",
): RoutableAccount[] {
	const excluded = new Set(exclusions);
	const snapshotFor = (id: string | null) => (report ? findRateLimitSnapshot(report, kind, id) : null);
	const kindState = state[kind];
	const out: RoutableAccount[] = kindState.accounts.map((account) => {
		const snapshot = snapshotFor(account.id);
		return {
			id: account.id,
			label: account.label,
			metered: account.auth === "api" || isMeteredPlan(account.identity?.plan) || isMeteredPlan(snapshot?.planType),
			excluded: excluded.has(account.id),
			dedupeKey: dedupeKeyFor(kind, account.identity),
			snapshot,
		};
	});
	const systemIdentity = kind === "claude" ? state.claude.systemIdentity : state.codex.currentIdentity;
	if (systemIdentity) {
		const snapshot = snapshotFor(null);
		out.push({
			id: null,
			label: systemIdentity.email ?? systemLabel,
			metered: isMeteredPlan(systemIdentity.plan) || isMeteredPlan(snapshot?.planType),
			excluded: excluded.has(systemLoginExclusionKey(kind)),
			dedupeKey: dedupeKeyFor(kind, systemIdentity),
			snapshot,
		});
	}
	return out;
}

/** Subscription logins Auto could ever choose between (ignores live usage). */
export function autoCandidateCount(accounts: RoutableAccount[]): number {
	const keys = new Set<string>();
	let anonymous = 0;
	for (const a of accounts) {
		if (a.metered || a.excluded) continue;
		if (a.dedupeKey) keys.add(a.dedupeKey);
		else anonymous++;
	}
	return keys.size + anonymous;
}
