/**
 * Bun-side state for the "Auto" account choice: the in-flight reservations
 * and hysteresis the pure router (src/shared/account-routing.ts) needs to see
 * across launches. In memory on purpose — a restart forgets them, and the next
 * limit reading covers what they predicted.
 */
import {
	ROUTING_PARAMS,
	buildRoutableAccounts,
	routeAccount,
	type AccountPickReason,
	type AccountReservation,
	type AssessedAccount,
} from "../shared/account-routing";
import { homedir } from "node:os";
import type { RoutableAccountKind } from "../shared/agent-accounts";
import { pinnedClaudeConfigDir } from "../shared/claude-config-dir";
import type { Project } from "../shared/types";
import { listAgentAccounts } from "./agent-accounts";
import { resolveProjectEnv } from "./repo-config";
import { getAgentRateLimitsReport, getCachedRateLimitsReport } from "./rate-limit-monitor";
import { loadSettings } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("account-router");

export class NoEligibleAccountError extends Error {
	override name = "NoEligibleAccountError";

	constructor(
		readonly kind: RoutableAccountKind,
		readonly earliestResetAt: number | null,
	) {
		super(
			earliestResetAt
				? `No ${kind} subscription account has room for Auto until ${new Date(earliestResetAt).toISOString()}`
				: `No ${kind} subscription account is available for Auto`,
		);
	}
}

export interface AutoAccountPick {
	accountId: string | null;
	label: string;
	reason: AccountPickReason;
}

export interface AutoAccountPreview {
	picked: boolean;
	accountId: string | null;
	label: string | null;
	reason: AccountPickReason;
	assessed: AssessedAccount[];
}

interface TaggedReservation extends AccountReservation {
	key: string;
}

/** What a fresh launch hands the command resolver so Auto can route it. */
export interface AutoRoutingContext {
	exclusions: readonly string[];
	/** The project's env pins CLAUDE_CONFIG_DIR: Auto then defers to the default. */
	claudeConfigPinned: boolean;
	reservationKey: string;
}

export async function autoRoutingContext(
	project: Project,
	reservationKey: string,
	projectEnv?: Record<string, string>,
): Promise<AutoRoutingContext> {
	const env = projectEnv ?? (await resolveProjectEnv(project));
	return {
		exclusions: project.autoAccountExclusions ?? [],
		claudeConfigPinned: pinnedClaudeConfigDir(env.CLAUDE_CONFIG_DIR, homedir(), project.path) != null,
		reservationKey,
	};
}

let reservations: TaggedReservation[] = [];
const cooling = new Map<RoutableAccountKind, Set<string>>();

function liveReservations(now: number): TaggedReservation[] {
	reservations = reservations.filter((r) => now - r.at < ROUTING_PARAMS.reservationMs);
	return reservations;
}

async function routingInputs(kind: RoutableAccountKind, exclusions: readonly string[]) {
	const [state, report] = await Promise.all([
		listAgentAccounts(),
		Promise.resolve(getCachedRateLimitsReport() ?? getAgentRateLimitsReport()),
	]);
	return buildRoutableAccounts(kind, state, report, exclusions);
}

/** Whether a launch left on the default should be routed for this harness. */
export async function isAutoAccountDefault(kind: RoutableAccountKind): Promise<boolean> {
	return (await loadSettings()).autoAccountDefault?.[kind] === true;
}

/**
 * Pick an account for one fresh launch and reserve its predicted cost. The
 * route + reserve step is synchronous, so a burst of launches sees each
 * other's reservations. Throws NoEligibleAccountError — never falls back to a
 * metered login.
 */
export async function pickAutoAccount(opts: {
	kind: RoutableAccountKind;
	exclusions?: readonly string[];
	/** Tags the reservation so a failed launch can release it. */
	reservationKey: string;
}): Promise<AutoAccountPick> {
	const accounts = await routingInputs(opts.kind, opts.exclusions ?? []);
	const now = Date.now();
	const result = routeAccount({ accounts, reservations: liveReservations(now), now, cooling: cooling.get(opts.kind) });
	cooling.set(opts.kind, result.cooling);
	if (!result.picked) {
		const earliest = result.reason.code === "none" ? result.reason.earliestResetAt : null;
		log.info("Auto account: nothing eligible", { kind: opts.kind, earliest });
		throw new NoEligibleAccountError(opts.kind, earliest);
	}
	reservations.push({
		key: opts.reservationKey,
		accountId: result.accountId,
		at: now,
		short: ROUTING_PARAMS.reserveShort,
		weekly: ROUTING_PARAMS.reserveWeekly,
	});
	log.info("Auto account picked", { kind: opts.kind, reason: result.reason.code, system: result.accountId === null });
	return { accountId: result.accountId, label: result.label ?? "", reason: result.reason };
}

/** What Auto would pick right now, without reserving anything. */
export async function previewAutoAccount(opts: {
	kind: RoutableAccountKind;
	exclusions?: readonly string[];
}): Promise<AutoAccountPreview> {
	const accounts = await routingInputs(opts.kind, opts.exclusions ?? []);
	const now = Date.now();
	const result = routeAccount({ accounts, reservations: liveReservations(now), now, cooling: cooling.get(opts.kind) });
	return { picked: result.picked, accountId: result.accountId, label: result.label, reason: result.reason, assessed: result.assessed };
}

/** Drop the reservation of a launch that never started. */
export function releaseAccountReservation(reservationKey: string): void {
	reservations = reservations.filter((r) => r.key !== reservationKey);
}

export function resetAccountRouterForTests(): void {
	reservations = [];
	cooling.clear();
}
