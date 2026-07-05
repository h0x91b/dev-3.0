import type { Automation, AutomationRun, Project } from "../shared/types";
import { occurrencesBetween, parseRRule, type RRuleSpec } from "../shared/rrule";
import * as data from "./data";
import { computeNextRunAt, loadAutomations, recordAutomationRuns } from "./automations-data";
import { createAutomationTask } from "./rpc-handlers/task-lifecycle";
import { getPushMessage } from "./rpc-handlers/shared";
import { createLogger } from "./logger";

const log = createLogger("automations-scheduler");

/** How often the scheduler wakes up to check for due occurrences. */
const TICK_INTERVAL_MS = 30_000;

/**
 * An occurrence older than this at check time counts as MISSED (the app was
 * offline / asleep), not late. A running scheduler's worst-case lateness is one
 * tick (30 s), so 5 minutes cleanly separates "late tick" from "was not running".
 */
export const MISSED_GRACE_MS = 5 * 60_000;

export interface DueEvaluation {
	/** Occurrences that fired into the void while the app was offline (oldest first). */
	missed: Date[];
	/** The occurrence to fire now, if any. */
	due: Date | null;
	/** True when `due` is a catch-up substitute for missed occurrences (runOnce policy). */
	dueIsCatchUp: boolean;
}

/**
 * Classify everything that should have fired between the persisted `nextRunAt`
 * and `now`. Pure — unit-tested directly.
 *
 * - occurrences within {@link MISSED_GRACE_MS} of `now`: the latest one is due
 *   (a normally-running scheduler hits exactly this with one occurrence).
 * - older occurrences are missed. With `catchUp: "runOnce"` and nothing
 *   naturally due, the latest missed occurrence is promoted to a single
 *   catch-up fire — never one task per missed slot (at-least-once, bounded).
 */
export function evaluateDue(
	nextRunAt: Date,
	now: Date,
	spec: RRuleSpec,
	timezone: string,
	anchor: Date,
	catchUp: "skip" | "runOnce",
	graceMs: number = MISSED_GRACE_MS,
): DueEvaluation {
	if (nextRunAt.getTime() > now.getTime()) return { missed: [], due: null, dueIsCatchUp: false };

	const occurrences = [nextRunAt, ...occurrencesBetween(spec, nextRunAt, now, timezone, anchor)]
		.filter((occ) => occ.getTime() <= now.getTime());

	const missed = occurrences.filter((occ) => now.getTime() - occ.getTime() > graceMs);
	const fresh = occurrences.filter((occ) => now.getTime() - occ.getTime() <= graceMs);

	if (fresh.length > 0) {
		// Anything fresh beyond the latest is folded into missed (never double-fire).
		return { missed: [...missed, ...fresh.slice(0, -1)], due: fresh[fresh.length - 1], dueIsCatchUp: false };
	}
	if (missed.length > 0 && catchUp === "runOnce") {
		return { missed: missed.slice(0, -1), due: missed[missed.length - 1], dueIsCatchUp: true };
	}
	return { missed, due: null, dueIsCatchUp: false };
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export function startAutomationsScheduler(): void {
	if (timer) return;
	log.info("Automations scheduler started", { tickMs: TICK_INTERVAL_MS });
	// First tick runs immediately: it is also the offline missed-run detection.
	void tick();
	timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopAutomationsScheduler(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function tick(): Promise<void> {
	if (tickInFlight) return; // never overlap ticks — the double-fire guard
	tickInFlight = true;
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				await tickProject(project);
			} catch (err) {
				log.error("Automation tick failed for project", { projectId: project.id, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Automation tick failed", { error: String(err) });
	} finally {
		tickInFlight = false;
	}
}

async function tickProject(project: Project): Promise<void> {
	const automations = await loadAutomations(project);
	if (automations.length === 0) return;
	const now = new Date();

	for (const automation of automations) {
		if (!automation.enabled) continue;

		// Heal a missing nextRunAt (older file, or a rule that failed to compute
		// at save time) so the automation starts ticking instead of sleeping forever.
		if (!automation.nextRunAt) {
			const healed = computeNextRunAt(automation, now);
			if (healed) {
				await recordAutomationRuns(project, automation.id, [], { nextRunAt: healed });
				getPushMessage()?.("automationsUpdated", { projectId: project.id });
			}
			continue;
		}

		const nextRunAt = new Date(automation.nextRunAt);
		if (nextRunAt.getTime() > now.getTime()) continue;

		let spec: RRuleSpec;
		try {
			spec = parseRRule(automation.rrule);
		} catch (err) {
			log.error("Automation has an unparseable rrule; disabling its clock", { automationId: automation.id, error: String(err) });
			await recordAutomationRuns(project, automation.id, [], { nextRunAt: null });
			continue;
		}

		const anchor = new Date(automation.createdAt);
		const { missed, due, dueIsCatchUp } = evaluateDue(nextRunAt, now, spec, automation.timezone, anchor, automation.catchUp);

		// Advance the clock FIRST (with the missed entries), so a crash while the
		// task spawns can at worst refire the current occurrence — never replay
		// the whole backlog. Prompts are expected to be idempotent (at-least-once).
		const missedRuns: AutomationRun[] = missed.map((occ) => ({
			id: crypto.randomUUID(),
			scheduledFor: occ.toISOString(),
			firedAt: null,
			status: "missed" as const,
		}));
		const newNextRunAt = computeNextRunAt(automation, now);
		await recordAutomationRuns(project, automation.id, missedRuns, { nextRunAt: newNextRunAt });

		let fireRun: AutomationRun | null = null;
		if (due) {
			fireRun = await fireAutomation(project, automation, due);
			await recordAutomationRuns(project, automation.id, [fireRun]);
		}

		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		if (missed.length > 0 || dueIsCatchUp) {
			const missedCount = missed.length + (dueIsCatchUp ? 1 : 0);
			log.warn("Automation missed occurrences while offline", {
				automationId: automation.id.slice(0, 8),
				name: automation.name,
				missedCount,
				caughtUp: dueIsCatchUp,
			});
			getPushMessage()?.("automationRunsMissed", {
				projectId: project.id,
				automationId: automation.id,
				automationName: automation.name,
				missedCount,
				caughtUp: dueIsCatchUp,
			});
		}
	}
}

async function fireAutomation(project: Project, automation: Automation, scheduledFor: Date): Promise<AutomationRun> {
	const firedAt = new Date().toISOString();
	try {
		const task = await createAutomationTask(project, automation);
		log.info("Automation fired", {
			automationId: automation.id.slice(0, 8),
			name: automation.name,
			taskId: task.id.slice(0, 8),
			scheduledFor: scheduledFor.toISOString(),
		});
		return {
			id: crypto.randomUUID(),
			scheduledFor: scheduledFor.toISOString(),
			firedAt,
			status: "created",
			taskId: task.id,
		};
	} catch (err) {
		log.error("Automation fire failed", { automationId: automation.id.slice(0, 8), error: String(err) });
		return {
			id: crypto.randomUUID(),
			scheduledFor: scheduledFor.toISOString(),
			firedAt,
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Fire an automation immediately, bypassing (and not consuming) the schedule.
 * Used by the `runAutomationNow` RPC and `dev3 automations run`.
 */
export async function runAutomationNow(project: Project, automation: Automation): Promise<{ taskId: string }> {
	const now = new Date();
	const run = await fireAutomation(project, automation, now);
	await recordAutomationRuns(project, automation.id, [{ ...run, manual: true }]);
	getPushMessage()?.("automationsUpdated", { projectId: project.id });
	if (run.status === "failed") throw new Error(run.error || "Automation run failed");
	return { taskId: run.taskId! };
}
