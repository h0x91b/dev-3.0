/**
 * Real traffic data → the Strata stage's districts, machines and routes.
 *
 * This module is the whole answer to "only real data". Every field it produces
 * traces to something dev3 wrote down: a project, a task's `taskType`, a
 * projected status from `Task.movements[]`, or a row in the message log. There is
 * no simulation, no synthetic queue, no narrative and no progress score — the
 * demo this stage is modelled on had all four, and none of them survived the
 * port (see `decisions/2026/09/08/strata-carries-only-recorded-facts.md`).
 *
 * Pure and canvas-free, so the layout and the mapping are unit-testable without
 * WebGL.
 */

import type { AgentMessageLogRow } from "../../../../shared/agent-message-log";
import type { TaskStatus } from "../../../../shared/types";
import {
	endpointKey,
	fromKey,
	toKey,
	type TrafficNode,
	type TrafficRecord,
} from "../traffic-model";
import { projectTaskAt, type TaskProjection } from "../task-history";
import { noise, type Vec3 } from "./strata-math";

/** Which relationships the stage draws. A sub-mode of one presentation. */
export type StrataMode = "situation" | "waiting" | "traffic";

/** The shape a card takes, from its recorded `taskType` — never inferred. */
export type StrataRole = "coordinator" | "reviewer" | "worker";

/**
 * What a route means, straight off the row's delivery verdict.
 *
 * `queued` is a `scheduled` row whose `scheduledFor` is still ahead — a recorded
 * intent, drawn dotted and never as a delivery.
 */
export type StrataRouteKind = "delivered" | "held" | "failed" | "queued";

export interface StrataDistrict {
	id: string;
	/** Project name, or the quiet band's own label key. */
	name: string;
	/** Two-digit deck plate, in district order. Display only. */
	plate: string;
	center: Vec3;
	radius: number;
	color: string;
	/** True for the band holding cards with no message in the window. */
	quiet: boolean;
	taskCount: number;
	messageCount: number;
}

export interface StrataMachine {
	/** `endpointKey(projectId, taskId)` — the same identity the rest of the screen uses. */
	key: string;
	node: TrafficNode;
	districtId: string;
	pos: Vec3;
	role: StrataRole;
	projection: TaskProjection;
	/** Recorded status at the cursor, or null for NOT KNOWN. Drives colour. */
	status: TaskStatus | null;
	/** The board's current hibernated flag. Never recorded, so always current. */
	hibernated: boolean;
	/** A card the cursor proves did not exist yet: drawn at zero opacity, slot kept. */
	unborn: boolean;
	/** An inbound message at or before the cursor whose delivery failed. */
	undelivered: boolean;
	/** Distinct recorded statuses this card has passed through, capped at 3. */
	recordedStages: number;
	messageCount: number;
}

export interface StrataRoute {
	key: string;
	from: string;
	to: string;
	kind: StrataRouteKind;
	/** Newest record on this pair-and-kind, for the label and the inspector. */
	record: TrafficRecord;
	count: number;
}

/**
 * District hues.
 *
 * Deliberately NOT the status palette: a platform is an identity, and reusing a
 * status colour on it would make a whole project read as a state. Six entries
 * assigned by district order so a board keeps its colours across mounts.
 */
const DISTRICT_HUES = [
	"#83bdcf",
	"#b4a1dc",
	"#d5b58a",
	"#8fc0a4",
	"#cf9aa8",
	"#9fb3d9",
] as const;

/** The quiet band's own grey — outside the hue rotation, so it never reads as a project. */
const QUIET_HUE = "#71838f";

function roleOf(node: TrafficNode): StrataRole {
	const type = node.task?.taskType;
	if (type === "coordinator") return "coordinator";
	if (type === "pr-review") return "reviewer";
	return "worker";
}

/**
 * How many distinct statuses the card is *recorded* to have occupied by the
 * cursor, capped at three.
 *
 * This drives the three evidence shelves on a worker's flank. It is a count of
 * recorded movements, not a completion estimate: a task that went
 * `todo → in-progress` shows one shelf whether or not it is nearly finished, and
 * a task with no movements shows none. §5.9 forbids progress, and a count of
 * facts is not one.
 */
export function recordedStages(node: TrafficNode, at: number | null): number {
	const movements = node.task?.movements;
	if (!movements?.length) return 0;
	const seen = new Set<string>();
	for (const movement of movements) {
		const stamp = Date.parse(movement.at);
		if (!Number.isFinite(stamp)) continue;
		if (at !== null && stamp > at) continue;
		seen.add(movement.to);
	}
	return Math.min(3, seen.size);
}

/**
 * Districts and machines for one node set.
 *
 * A district per project that owns at least one card, plus one quiet band for
 * cards the window holds no message for — the same "quiet" idea Experiment 2's
 * layout has, expressed as its own platform instead of a counted row. Districts
 * are laid out on a ring sized by how many there are, and a card's slot inside
 * one is a deterministic function of its own key, so nothing moves between
 * mounts or while replay runs.
 */
export function strataScene(input: {
	nodes: TrafficNode[];
	projects: { id: string; name: string }[];
	records: TrafficRecord[];
	cursorAt: number | null;
}): { districts: StrataDistrict[]; machines: StrataMachine[] } {
	const { nodes, projects, records, cursorAt } = input;
	const touched = new Map<string, number>();
	for (const { row } of records) {
		for (const key of [fromKey(row), toKey(row)]) {
			if (key) touched.set(key, (touched.get(key) ?? 0) + 1);
		}
	}
	const undeliveredTo = new Set<string>();
	for (const { row } of records) {
		if (row.status !== "not-delivered") continue;
		const at = Date.parse(row.at);
		if (cursorAt !== null && Number.isFinite(at) && at > cursorAt) continue;
		undeliveredTo.add(toKey(row));
	}

	const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
	// A district per project, in the project list's own order so the hue is stable.
	const grouped = new Map<string, TrafficNode[]>();
	const quiet: TrafficNode[] = [];
	for (const node of nodes) {
		if (!touched.has(node.key)) {
			quiet.push(node);
			continue;
		}
		grouped.set(node.projectId, [...(grouped.get(node.projectId) ?? []), node]);
	}
	const order = [
		...projects.map((p) => p.id).filter((id) => grouped.has(id)),
		...[...grouped.keys()].filter((id) => !projectName.has(id)),
	];

	const districts: StrataDistrict[] = [];
	const machines: StrataMachine[] = [];
	const total = order.length + (quiet.length ? 1 : 0);
	// A ring wide enough that no two decks touch, and a slight vertical stagger so
	// the platforms read as strata rather than a flat pie chart.
	const ringRadius = total <= 1 ? 0 : 13 + total * 6.2;

	const place = (
		district: StrataDistrict,
		members: TrafficNode[],
	): void => {
		const ranked = [...members].sort(
			(a, b) =>
				Number(roleOf(b) === "coordinator") - Number(roleOf(a) === "coordinator") ||
				(b.seq ?? 0) - (a.seq ?? 0),
		);
		ranked.forEach((node, index) => {
			const role = roleOf(node);
			// The coordinator takes the deck's north slot; everyone else fills
			// concentric rings outward. Not hierarchy — a reading order, and the
			// caption says so (§5.9 "wires never imply parentage").
			let pos: Vec3;
			if (role === "coordinator" && index === 0) {
				pos = [district.center[0], district.center[1], district.center[2] - district.radius * 0.42];
			} else {
				const slot = role === "coordinator" ? index : index - (ranked[0] && roleOf(ranked[0]) === "coordinator" ? 1 : 0);
				const ring = Math.floor(slot / 6);
				const withinRing = slot % 6;
				const spread = district.radius * (0.34 + ring * 0.27);
				const angle = (withinRing / 6) * Math.PI * 2 + ring * 0.52 + 0.28;
				pos = [
					district.center[0] + Math.cos(angle) * spread,
					district.center[1],
					district.center[2] + Math.sin(angle) * spread * 0.92 + district.radius * 0.16,
				];
			}
			const projection = projectTaskAt(node.task, cursorAt);
			machines.push({
				key: node.key,
				node,
				districtId: district.id,
				pos,
				role,
				projection,
				status: projection.status,
				hibernated: !!node.task?.hibernated,
				unborn: !projection.present,
				undelivered: undeliveredTo.has(node.key),
				recordedStages: recordedStages(node, cursorAt),
				messageCount: touched.get(node.key) ?? 0,
			});
		});
	};

	order.forEach((projectId, index) => {
		const members = grouped.get(projectId) ?? [];
		const angle = total <= 1 ? 0 : (index / total) * Math.PI * 2 + 0.42;
		// Radius follows how many cards the deck holds, floored so a one-card
		// project is still a platform rather than a dot.
		const radius = Math.max(7.5, 6.4 + Math.sqrt(members.length) * 3.6);
		const district: StrataDistrict = {
			id: projectId,
			name: projectName.get(projectId) ?? projectId,
			plate: String(index + 1).padStart(2, "0"),
			center: [
				Math.cos(angle) * ringRadius,
				(noise(index * 7 + 3) - 0.5) * 2.1,
				Math.sin(angle) * ringRadius,
			],
			radius,
			color: DISTRICT_HUES[index % DISTRICT_HUES.length],
			quiet: false,
			taskCount: members.length,
			messageCount: members.reduce((sum, node) => sum + (touched.get(node.key) ?? 0), 0),
		};
		districts.push(district);
		place(district, members);
	});

	if (quiet.length) {
		const index = order.length;
		const angle = total <= 1 ? 0 : (index / total) * Math.PI * 2 + 0.42;
		const district: StrataDistrict = {
			id: "__quiet__",
			name: "",
			plate: String(index + 1).padStart(2, "0"),
			center: [Math.cos(angle) * ringRadius, -0.4, Math.sin(angle) * ringRadius],
			radius: Math.max(5.4, 4.6 + Math.sqrt(quiet.length) * 2.4),
			color: QUIET_HUE,
			quiet: true,
			taskCount: quiet.length,
			messageCount: 0,
		};
		districts.push(district);
		place(district, quiet);
	}
	return { districts, machines };
}

/** A row's route kind, straight from its recorded verdict. */
export function routeKindOf(row: AgentMessageLogRow, now: number): StrataRouteKind {
	if (row.kind === "scheduled" && row.scheduledFor) {
		const due = Date.parse(row.scheduledFor);
		if (Number.isFinite(due) && due > now) return "queued";
	}
	if (row.status === "not-delivered") return "failed";
	if (row.status === "held" || row.status === "unconfirmed") return "held";
	return "delivered";
}

/**
 * Routes for a scene mode.
 *
 * The three modes are three questions about the same rows, and each answers with
 * a subset — never with different data:
 *
 * - `traffic` — every recorded attempt in the window. The full map.
 * - `waiting` — only what has not landed: failed, held and still-queued. What the
 *   user would act on.
 * - `situation` — everything unlanded, plus the most recent handful of deliveries
 *   for context, so the default view is legible on a busy board.
 */
export function strataRoutes(
	records: TrafficRecord[],
	mode: StrataMode,
	now: number,
	recentDeliveries = 8,
): StrataRoute[] {
	const collapsed = new Map<string, StrataRoute>();
	const chronological = [...records].sort(
		(a, b) => Date.parse(a.row.at) - Date.parse(b.row.at),
	);
	const deliveredKeys: string[] = [];
	for (const record of chronological) {
		const row = record.row;
		const from = fromKey(row);
		if (!from) continue; // A senderless row has no route; its bubble is the screen's job.
		const to = toKey(row);
		if (from === to) continue;
		const kind = routeKindOf(row, now);
		if (mode === "waiting" && kind === "delivered") continue;
		const key = `${[from, to].sort().join("|")}::${kind}`;
		const existing = collapsed.get(key);
		collapsed.set(key, {
			key,
			from,
			to,
			kind,
			record,
			count: (existing?.count ?? 0) + 1,
		});
		if (kind === "delivered") deliveredKeys.push(key);
	}
	if (mode !== "situation") return [...collapsed.values()];
	// Keep every unlanded route and only the tail of the deliveries.
	const keep = new Set(deliveredKeys.slice(-recentDeliveries));
	return [...collapsed.values()].filter(
		(route) => route.kind !== "delivered" || keep.has(route.key),
	);
}

/**
 * The "what happened while you were away" line, computed from the window.
 *
 * Two numbers and a span, all measured: how many recorded events the window
 * holds and how long it covers. The demo this stage came from had a written
 * scenario here; a canned sentence about a board it cannot see is exactly the
 * narrative §5.9 forbids.
 */
export interface StrataSummary {
	events: number;
	attention: number;
	spanMs: number;
	undelivered: number;
	held: number;
	queued: number;
}

export function strataSummary(input: {
	records: TrafficRecord[];
	machines: StrataMachine[];
	now: number;
	windowStart: number;
}): StrataSummary {
	let undelivered = 0;
	let held = 0;
	let queued = 0;
	let oldest = input.now;
	for (const { row } of input.records) {
		const kind = routeKindOf(row, input.now);
		if (kind === "failed") undelivered++;
		else if (kind === "held") held++;
		else if (kind === "queued") queued++;
		const at = Date.parse(row.at);
		if (Number.isFinite(at)) oldest = Math.min(oldest, at);
	}
	const asking = input.machines.filter(
		(machine) => machine.status === "user-questions",
	).length;
	return {
		events: input.records.length,
		attention: asking + undelivered,
		spanMs: Math.max(0, input.now - Math.max(input.windowStart, oldest)),
		undelivered,
		held,
		queued,
	};
}

/** Node lookup keyed the way the rest of the screen keys it. */
export function machineIndex(machines: StrataMachine[]): Map<string, StrataMachine> {
	return new Map(machines.map((machine) => [machine.key, machine] as const));
}

export { endpointKey };
