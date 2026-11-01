import type { AgentUsageDay, AgentUsageReport, ProductivityStatEvent, ProductivityStats, SystemMemorySnapshot, TaskUsageReport } from "../types";
import type { AgentRateLimitsReport } from "../rate-limits";
import type { PendingApprovalSummary } from "../agent-approval";
import type { ModelRate } from "../agent-pricing";

/**
 * `dev3 stats … --json` and `dev3 approvals list --json` are public contracts
 * like `task show --json`: additive changes keep the version, removing or
 * renaming a field bumps it.
 */
export const STATS_JSON_SCHEMA_VERSION = 1;

export function statsJson<T extends Record<string, unknown>>(payload: T): { schemaVersion: typeof STATS_JSON_SCHEMA_VERSION } & T {
	return { schemaVersion: STATS_JSON_SCHEMA_VERSION, ...payload };
}

/** A task counts when anything happened to it at or after `since`. */
export function productivityEventActiveSince(event: ProductivityStatEvent, since: string): boolean {
	const sinceMs = Date.parse(since);
	const after = (iso: string | null) => iso !== null && Date.parse(iso) >= sinceMs;
	return after(event.createdAt) || after(event.movedAt) || after(event.statusEnteredAt)
		|| event.movements.some((m) => after(m.at));
}

/** A day counts when any part of it falls at or after `since`. Days are local, so a DST day is 23 or 25 hours. */
export function usageDayOverlapsSince(day: AgentUsageDay, since: string): boolean {
	const start = new Date(day.startMs);
	const nextMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
	return nextMidnight > Date.parse(since);
}

/** What `stats.prices` answers over the socket. */
export interface PricesWire {
	fetchedAt: number | null;
	models: Array<{ model: string; rate: ModelRate | null }>;
}

export function pricesJson(wire: PricesWire) {
	const fetchedAt = wire.fetchedAt === null ? null : new Date(wire.fetchedAt).toISOString();
	const source = fetchedAt ? "refreshed" : "built-in";
	const models = wire.models.map(({ model, rate }) => rate
		? { model, priced: true as const, input: rate.input, output: rate.output, cacheWrite5m: rate.cacheWrite5m, cacheWrite1h: rate.cacheWrite1h, cacheRead: rate.cacheRead }
		: { model, priced: false as const });
	return statsJson({ currency: "USD", unit: "per 1M tokens", source, fetchedAt, models });
}

/** `dev3 stats productivity --json`, filtered the way the CLI filters it. */
export function productivityJson(stats: ProductivityStats, opts: { since: string | null; projectId: string | null }) {
	const { since, projectId } = opts;
	const events = stats.events.filter((e) =>
		(!projectId || e.projectId === projectId) && (!since || productivityEventActiveSince(e, since)));
	return statsJson({ generatedAt: stats.generatedAt, since, projectId, events });
}

/** `dev3 stats usage --json` (every agent, by day). */
export function usageJson(report: AgentUsageReport, since: string | null) {
	const days = since ? report.days.filter((d) => usageDayOverlapsSince(d, since)) : report.days;
	return statsJson({ generatedAt: report.generatedAt, since, hasUnpricedModels: days.some((d) => !d.fullyPriced), days });
}

/** `dev3 stats usage --task --json`. */
export function taskUsageJson(report: TaskUsageReport) {
	return statsJson({ ...report });
}

/** `dev3 stats limits --json`. */
export function limitsJson(report: AgentRateLimitsReport) {
	return statsJson({ generatedAt: new Date(report.generatedAt).toISOString(), snapshots: report.snapshots, sessions: report.sessions ?? [] });
}

/** `dev3 stats memory --json`. */
export function memoryJson(snapshot: SystemMemorySnapshot | null) {
	return statsJson({ snapshot });
}

/** `dev3 approvals list --json`. */
export function approvalsJson(requests: PendingApprovalSummary[], projectId: string | null) {
	return statsJson({ projectId, requests: projectId ? requests.filter((r) => r.projectId === projectId) : requests });
}
