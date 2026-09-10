import type { PlacedNode } from "./nodes-layout";

/** Ports sit this far inside a card edge, so a fanned-out wire never leaves at a corner. */
const PORT_MARGIN = 34;
/** Room a lane asks for; compressed when the group does not fit. */
const PORT_STEP = 26;
const BUS_STEP = 22;
/** Matches CLEARANCE in nodes-routing: a bus line closer than this to a card is unroutable. */
const BUS_CLEARANCE = 26;

export interface WirePair {
	key: string;
	/** Sender and recipient of the newest attempt, as the layout resolved them. */
	a: PlacedNode;
	b: PlacedNode;
}

export interface LanePlan {
	/** x of the port on the upper card's bottom edge. */
	exitX: number;
	/** x of the port on the lower card's top edge. */
	entryX: number;
	/** y of the horizontal run between the two rows. */
	bus: number;
	/** Lane index inside its corridor, for debugging and tests. */
	lane: number;
	/** The corridor could not give every lane its full step. */
	compressed: boolean;
}

/** Same test as nodes-layout's wire(): near-equal y means a side-to-side wire. */
export const isVertical = (a: PlacedNode, b: PlacedNode) => Math.abs(a.y - b.y) >= 30;

const ends = (pair: WirePair) => (pair.b.y > pair.a.y ? [pair.a, pair.b] : [pair.b, pair.a]) as [PlacedNode, PlacedNode];

/** The single bus line every wire between two rows used to share. */
export function baseBus(top: PlacedNode, bottom: PlacedNode): number {
	const start = top.y + top.height;
	const end = bottom.y;
	return top.node.task?.taskType === "coordinator" ? Math.min(end - 38, start + 54) : (start + end) / 2;
}

/** Even offsets around the middle: lane 0 of 3 sits one step left, lane 1 dead centre. */
function offsets(count: number, step: number): number[] {
	return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * step);
}

function group<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const bucket = map.get(key);
		if (bucket) bucket.push(item);
		else map.set(key, [item]);
	}
	return map;
}

/**
 * Spreads wires that would otherwise share one port and one bus line onto parallel
 * lanes. Every wire out of a card gets its own x on the card's edge and its own y in
 * the corridor below it, ordered left to right by where the wire is heading — so the
 * bundle reads as separate cables instead of one trunk with everything drawn on top.
 * Deterministic: the same scene always yields the same lanes.
 */
export function planLanes(pairs: WirePair[]): Map<string, LanePlan> {
	const plans = new Map<string, LanePlan>();
	const vertical = pairs.filter((pair) => isVertical(pair.a, pair.b));
	const compressedKeys = new Set<string>();

	const spread = (
		members: WirePair[],
		step: number,
		order: (pair: WirePair) => number,
		room: number,
	): { pair: WirePair; offset: number; lane: number }[] => {
		const sorted = [...members].sort((one, other) => order(one) - order(other) || one.key.localeCompare(other.key));
		const fitted = sorted.length > 1 ? Math.min(step, room / (sorted.length - 1)) : 0;
		if (sorted.length > 1 && fitted < step - 0.001) for (const pair of sorted) compressedKeys.add(pair.key);
		const values = offsets(sorted.length, fitted);
		return sorted.map((pair, index) => ({ pair, offset: values[index], lane: index }));
	};

	const exits = new Map<string, number>();
	const lanes = new Map<string, number>();
	for (const [, members] of group(vertical, (pair) => ends(pair)[0].node.key)) {
		const [top] = ends(members[0]);
		const room = Math.max(0, top.width - PORT_MARGIN * 2);
		for (const { pair, offset, lane } of spread(members, PORT_STEP, (one) => ends(one)[1].x + ends(one)[1].width / 2, room)) {
			exits.set(pair.key, top.x + top.width / 2 + offset);
			lanes.set(pair.key, lane);
		}
	}

	const entries = new Map<string, number>();
	for (const [, members] of group(vertical, (pair) => ends(pair)[1].node.key)) {
		const bottom = ends(members[0])[1];
		const room = Math.max(0, bottom.width - PORT_MARGIN * 2);
		for (const { pair, offset } of spread(members, PORT_STEP, (one) => ends(one)[0].x + ends(one)[0].width / 2, room)) {
			entries.set(pair.key, bottom.x + bottom.width / 2 + offset);
		}
	}

	const buses = new Map<string, number>();
	for (const [, members] of group(vertical, (pair) => {
		const [top, bottom] = ends(pair);
		return `${top.node.key}|${Math.round(baseBus(top, bottom))}`;
	})) {
		const [top, bottom] = ends(members[0]);
		const centre = baseBus(top, bottom);
		// The corridor is what is left between the two cards once clearance is honoured.
		const room = Math.max(0, Math.min(centre - (top.y + top.height + BUS_CLEARANCE), bottom.y - BUS_CLEARANCE - centre) * 2);
		for (const { pair, offset } of spread(members, BUS_STEP, (one) => entries.get(one.key) ?? ends(one)[1].x, room)) {
			buses.set(pair.key, centre + offset);
		}
	}

	for (const pair of vertical) {
		const [top, bottom] = ends(pair);
		plans.set(pair.key, {
			exitX: exits.get(pair.key) ?? top.x + top.width / 2,
			entryX: entries.get(pair.key) ?? bottom.x + bottom.width / 2,
			bus: buses.get(pair.key) ?? baseBus(top, bottom),
			lane: lanes.get(pair.key) ?? 0,
			compressed: compressedKeys.has(pair.key),
		});
	}
	return plans;
}

/** Every x and y a lane plan introduces, so the router's grid can carry them. */
export function laneGridLines(plans: Map<string, LanePlan>): { xs: number[]; ys: number[] } {
	const xs = new Set<number>();
	const ys = new Set<number>();
	for (const plan of plans.values()) {
		xs.add(plan.exitX);
		xs.add(plan.entryX);
		ys.add(plan.bus);
	}
	return { xs: [...xs], ys: [...ys] };
}
