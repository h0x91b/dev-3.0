/**
 * Which projects the traffic stage admits.
 *
 * The scope control used to offer exactly two shapes — every visible project, or
 * one named project — so a machine with twenty boards and two busy ones spent the
 * stage on eighteen empty blocks. `active` is a third shape: the projects a
 * recorded event in the current window actually touched.
 *
 * "Recorded" is the whole definition. Membership is read off the replay timeline,
 * so it is exactly what the screen can already prove happened — never a running
 * status, never a coordinator, never "the project exists". A project with a
 * coordinator and no events is out; a project with events and no coordinator is
 * in. The timeline is also where a further event kind lands (§5.9's notification
 * arm is a control value with no arm behind it yet), so that kind becomes
 * evidence of activity here the day it becomes an event, with nothing to change.
 */

import type { TrafficTimelineEvent } from "./traffic-timeline";

/** Every project the user can see, unfiltered — the pre-existing behaviour. */
export const ALL_PROJECTS = "all";
/** Only the projects a recorded event in the window touched. */
export const ACTIVE_PROJECTS = "active";

/**
 * True when the scope names no single project, so a stage has no lane to pin and
 * no block to keep alive on its own.
 */
export function isAggregateScope(scope: string | undefined): boolean {
	return scope === undefined || scope === ALL_PROJECTS || scope === ACTIVE_PROJECTS;
}

/**
 * Projects touched by the events handed in.
 *
 * A message counts for both ends: the sender's project is as much a participant
 * as the recipient's, and a cross-project message that only counted its
 * destination would drop the board the work came from.
 */
export function activeProjectIds(
	events: readonly TrafficTimelineEvent[],
): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.kind === "task") {
			ids.add(event.node.projectId);
			continue;
		}
		const { row } = event.record;
		ids.add(row.toProjectId);
		if (row.fromProjectId) ids.add(row.fromProjectId);
	}
	return ids;
}

/**
 * The project ids a scope admits, or `null` for "no project filter at all".
 *
 * `null` is not an empty set and the two must never be conflated: an empty set
 * admits nothing, `null` admits everything. `ALL_PROJECTS` returns `null` so it
 * stays byte-identical to the unfiltered path it has always been.
 *
 * `settled` is the honesty gate. History arrives page by page, and a window whose
 * rows have not loaded yet holds no evidence in either direction — §5.9's
 * "unrecorded state is unknown". Filtering on it would present "not read yet" as
 * "nothing happened" and hide a busy board behind the loading indicator, so until
 * the read finishes `active` admits everything and the screen's own loading
 * readout says why.
 */
export function scopeProjectIds(input: {
	scope: string;
	active: ReadonlySet<string>;
	settled: boolean;
}): ReadonlySet<string> | null {
	if (input.scope === ALL_PROJECTS) return null;
	if (input.scope !== ACTIVE_PROJECTS) return new Set([input.scope]);
	return input.settled ? input.active : null;
}

/** Whether a project id passes the resolved scope; `null` passes anything. */
export function admits(
	projects: ReadonlySet<string> | null,
	projectId: string | null | undefined,
): boolean {
	if (!projects) return true;
	return !!projectId && projects.has(projectId);
}
