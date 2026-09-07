import { fromKey, toKey, type TrafficNode, type TrafficRecord } from "./traffic-model";

/** Card footprint and the gaps between cards, in scene units (= CSS px at scale 1). */
export const CARD_WIDTH = 196;
export const CARD_HEIGHT = 96;
const GAP_X = 40;
const GAP_Y = 66;
/** Padding between a row of correspondents and the bracket drawn around it. */
const BRACKET_PAD = 14;
/** Widest row a hub's correspondents form before wrapping to the next one. */
const ROW_WIDTH = 6;

export interface PlacedNode {
	node: TrafficNode;
	x: number;
	y: number;
	/** Distinct partners this node exchanged messages with in the current window. */
	partners: number;
	messages: number;
	/** Rendered as the hub of its group: a coordinator, or the busiest node in it. */
	hub: boolean;
	/** Hibernated: parked in the band at the bottom, greyed, out of the conversation. */
	parked: boolean;
}

export interface PlacedEdge {
	key: string;
	from: string;
	to: string;
	/** Polyline through which a message travels; also the drawn wire. */
	points: { x: number; y: number }[];
	messages: number;
	/** Delivery status of the most recent attempt on this pair. */
	status: string;
	lastAt: number;
	subject: string;
}

/** The rounded outline drawn around one row of a hub's correspondents. */
export interface Bracket {
	key: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TrafficScene {
	placed: PlacedNode[];
	edges: PlacedEdge[];
	brackets: Bracket[];
	width: number;
	height: number;
	/** How many tasks each collapsible band holds, shown or not. */
	quietCount: number;
	parkedCount: number;
}

export interface SceneOptions {
	/** Draw the tasks that exchanged nothing in this window. Off by default. */
	showQuiet?: boolean;
	/** Draw the hibernated band. Off by default. */
	showParked?: boolean;
}

interface PairState {
	from: string;
	to: string;
	messages: number;
	status: string;
	lastAt: number;
	subject: string;
}

/** Message pairs, newest attempt winning the pair's status and subject. */
function pairs(records: TrafficRecord[]): Map<string, PairState> {
	const found = new Map<string, PairState>();
	for (const { row } of records) {
		const from = fromKey(row);
		if (!from) continue;
		const to = toKey(row);
		if (from === to) continue;
		const key = [from, to].sort().join("|");
		const at = Date.parse(row.at);
		const existing = found.get(key);
		if (!existing) {
			found.set(key, {
				from,
				to,
				messages: 1,
				status: row.status,
				lastAt: at,
				subject: row.subject ?? "",
			});
			continue;
		}
		existing.messages += 1;
		if (at >= existing.lastAt) {
			existing.lastAt = at;
			existing.status = row.status;
			existing.subject = row.subject ?? "";
			existing.from = from;
			existing.to = to;
		}
	}
	return found;
}

/**
 * Where every card and wire sits. Pure geometry so the view can render, animate
 * and hit-test from one description, and so the layout is unit-testable without
 * a DOM.
 *
 * Shape of the result: one **group per conversation**. Each group leads with a
 * hub — the coordinator if the group has one, otherwise its busiest node —
 * with everyone it talked to laid out in rows beneath it. Tasks nobody messaged
 * form a trailing quiet band, because a node with no wire has no place in a
 * conversation and hiding it would misreport who is on the board.
 *
 * **Hibernated tasks sink to a band of their own at the very bottom**, out of
 * every group even when they did exchange messages. On a real board most tasks
 * are parked, and mixed into the conversation they bury the handful that is
 * actually running — the same reason the Kanban sinks them below every live P4.
 * Their wires still draw, so the history stays honest; they just stop competing.
 *
 * **Both trailing bands are collapsed by default.** A 43-task board with four
 * messages rendered 43 cards and four wires: a census of the board, not its
 * traffic. The counts are still reported so the view can say what it is not
 * drawing — hiding a task silently is the failure this surface must not have.
 */
export function layoutTraffic(
	nodes: TrafficNode[],
	records: TrafficRecord[],
	options: SceneOptions = {},
): TrafficScene {
	const byKey = new Map(nodes.map((node) => [node.key, node]));
	const parked = new Set(
		nodes.filter((node) => node.task?.hibernated === true).map((node) => node.key),
	);
	const state = pairs(records);
	const partners = new Map<string, Set<string>>();
	const messages = new Map<string, number>();
	for (const pair of state.values()) {
		for (const [self, other] of [
			[pair.from, pair.to],
			[pair.to, pair.from],
		]) {
			if (!byKey.has(self)) continue;
			const set = partners.get(self) ?? new Set<string>();
			set.add(other);
			partners.set(self, set);
			messages.set(self, (messages.get(self) ?? 0) + pair.messages);
		}
	}

	const connected = new Map<string, Set<string>>();
	for (const pair of state.values()) {
		if (!byKey.has(pair.from) || !byKey.has(pair.to)) continue;
		if (parked.has(pair.from) || parked.has(pair.to)) continue;
		for (const [self, other] of [
			[pair.from, pair.to],
			[pair.to, pair.from],
		]) {
			const set = connected.get(self) ?? new Set<string>();
			set.add(other);
			connected.set(self, set);
		}
	}

	const rank = (key: string) => {
		const node = byKey.get(key);
		return [
			node?.task?.taskType === "coordinator" ? 1 : 0,
			connected.get(key)?.size ?? 0,
			node?.seq ?? 0,
		] as const;
	};
	const better = (a: string, b: string) => {
		const [ac, ad, as] = rank(a);
		const [bc, bd, bs] = rank(b);
		return ac !== bc ? ac > bc : ad !== bd ? ad > bd : as > bs;
	};

	// Groups: one per connected conversation, hub first, then BFS by distance.
	const seen = new Set<string>();
	const groups: string[][] = [];
	const talkative = [...connected.keys()].sort((a, b) => (better(a, b) ? -1 : 1));
	for (const start of talkative) {
		if (seen.has(start)) continue;
		const group: string[] = [];
		const queue = [start];
		seen.add(start);
		while (queue.length) {
			const key = queue.shift() as string;
			group.push(key);
			for (const next of [...(connected.get(key) ?? [])].sort()) {
				if (seen.has(next) || !byKey.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
		groups.push(group);
	}
	const quiet = nodes.filter((node) => !seen.has(node.key) && !parked.has(node.key));
	const asleep = nodes.filter((node) => parked.has(node.key));

	const positions = new Map<string, { x: number; y: number }>();
	const placed: PlacedNode[] = [];
	const brackets: Bracket[] = [];
	const step = CARD_WIDTH + GAP_X;
	let cursorY = 0;
	let width = 0;
	const place = (key: string, x: number, y: number, hub: boolean) => {
		const node = byKey.get(key);
		if (!node) return;
		positions.set(key, { x, y });
		placed.push({
			node,
			x,
			y,
			partners: partners.get(key)?.size ?? 0,
			messages: messages.get(key) ?? 0,
			hub,
			parked: parked.has(key),
		});
		width = Math.max(width, x + CARD_WIDTH);
	};

	for (const group of groups) {
		const [hub, ...rest] = group;
		const rows = Math.max(1, Math.ceil(rest.length / ROW_WIDTH));
		const widest = Math.min(Math.max(rest.length, 1), ROW_WIDTH);
		const groupWidth = widest * step - GAP_X;
		place(hub, (groupWidth - CARD_WIDTH) / 2, cursorY, true);
		rest.forEach((key, index) => {
			const row = Math.floor(index / ROW_WIDTH);
			const inRow = rest.slice(row * ROW_WIDTH, (row + 1) * ROW_WIDTH).length;
			const offset = (groupWidth - (inRow * step - GAP_X)) / 2;
			place(
				key,
				offset + (index % ROW_WIDTH) * step,
				cursorY + (row + 1) * (CARD_HEIGHT + GAP_Y),
				false,
			);
		});
		// One bracket per row of correspondents, the way the approved concept groups
		// them: the bus enters its top edge, so a row reads as one delegation.
		for (let row = 0; row < rows; row += 1) {
			const inRow = rest.slice(row * ROW_WIDTH, (row + 1) * ROW_WIDTH);
			if (!inRow.length) continue;
			const rowWidth = inRow.length * step - GAP_X;
			const offset = (groupWidth - rowWidth) / 2;
			brackets.push({
				key: `${group[0]}:${row}`,
				x: offset - BRACKET_PAD,
				y: cursorY + (row + 1) * (CARD_HEIGHT + GAP_Y) - BRACKET_PAD,
				width: rowWidth + BRACKET_PAD * 2,
				height: CARD_HEIGHT + BRACKET_PAD * 2,
			});
		}
		cursorY += (rows + 1) * (CARD_HEIGHT + GAP_Y);
	}
	const band = (members: TrafficNode[]) => {
		members.forEach((node, index) => {
			place(
				node.key,
				(index % ROW_WIDTH) * step,
				cursorY + Math.floor(index / ROW_WIDTH) * (CARD_HEIGHT + GAP_Y),
				false,
			);
		});
		if (members.length) {
			cursorY += Math.ceil(members.length / ROW_WIDTH) * (CARD_HEIGHT + GAP_Y);
		}
	};
	if (options.showQuiet) band(quiet);
	if (options.showParked) band(asleep);

	const edges: PlacedEdge[] = [];
	for (const [key, pair] of state) {
		const a = positions.get(pair.from);
		const b = positions.get(pair.to);
		if (!a || !b) continue;
		edges.push({
			key,
			from: pair.from,
			to: pair.to,
			points: wire(a, b),
			messages: pair.messages,
			status: pair.status,
			lastAt: pair.lastAt,
			subject: pair.subject,
		});
	}

	return {
		placed,
		edges,
		brackets,
		width: Math.max(width, step),
		height: Math.max(cursorY - GAP_Y, CARD_HEIGHT),
		quietCount: quiet.length,
		parkedCount: asleep.length,
	};
}

/**
 * The wire between two cards. Cards on different rows get an orthogonal drop —
 * out of the lower edge, across, into the upper edge — which is what makes a
 * hub read as a hub. Cards sharing a row get a shallow detour underneath them
 * instead, so the line never disappears inside the cards it connects.
 */
function wire(
	a: { x: number; y: number },
	b: { x: number; y: number },
): { x: number; y: number }[] {
	const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
	const topX = top.x + CARD_WIDTH / 2;
	const bottomX = bottom.x + CARD_WIDTH / 2;
	if (top.y === bottom.y) {
		const dip = top.y + CARD_HEIGHT + GAP_Y / 3;
		return [
			{ x: topX, y: top.y + CARD_HEIGHT },
			{ x: topX, y: dip },
			{ x: bottomX, y: dip },
			{ x: bottomX, y: bottom.y + CARD_HEIGHT },
		];
	}
	// The bus runs along the bracket's top edge, so a row of correspondents reads
	// as one delegation rather than as a bus and a box drawn near each other.
	const bus = bottom.y - BRACKET_PAD;
	return [
		{ x: topX, y: top.y + CARD_HEIGHT },
		{ x: topX, y: bus },
		{ x: bottomX, y: bus },
		{ x: bottomX, y: bottom.y },
	];
}

/** Rounded-corner path through a polyline — the wire as the browser draws it. */
export function wirePath(points: { x: number; y: number }[], radius = 12): string {
	if (points.length < 2) return "";
	let path = `M ${points[0].x} ${points[0].y}`;
	for (let index = 1; index < points.length - 1; index += 1) {
		const previous = points[index - 1];
		const corner = points[index];
		const next = points[index + 1];
		const inbound = Math.min(radius, distance(previous, corner) / 2);
		const outbound = Math.min(radius, distance(corner, next) / 2);
		const entry = along(corner, previous, inbound);
		const exit = along(corner, next, outbound);
		path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
	}
	const last = points[points.length - 1];
	return `${path} L ${last.x} ${last.y}`;
}

/** Point a given fraction along the polyline — where a message is right now. */
export function pointAt(
	points: { x: number; y: number }[],
	progress: number,
): { x: number; y: number } {
	const lengths = points.slice(1).map((point, index) => distance(points[index], point));
	const total = lengths.reduce((sum, value) => sum + value, 0);
	if (total === 0) return points[0];
	let travelled = Math.max(0, Math.min(1, progress)) * total;
	for (let index = 0; index < lengths.length; index += 1) {
		if (travelled <= lengths[index] || index === lengths.length - 1) {
			const ratio = lengths[index] === 0 ? 0 : travelled / lengths[index];
			return {
				x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
				y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
			};
		}
		travelled -= lengths[index];
	}
	return points[points.length - 1];
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	Math.hypot(b.x - a.x, b.y - a.y);

function along(
	from: { x: number; y: number },
	towards: { x: number; y: number },
	length: number,
): { x: number; y: number } {
	const span = distance(from, towards);
	if (span === 0) return from;
	return {
		x: from.x + ((towards.x - from.x) / span) * length,
		y: from.y + ((towards.y - from.y) / span) * length,
	};
}
