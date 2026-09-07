import { fromKey, toKey, type TrafficNode, type TrafficRecord } from "./traffic-model";

/** Card footprint and the gaps between cards, in scene units (= CSS px at scale 1). */
export const CARD_WIDTH = 208;
export const CARD_HEIGHT = 132;
const GAP_X = 44;
const GAP_Y = 92;
/** Widest row a hub's correspondents form before wrapping to the next one. */
const ROW_WIDTH = 4;

export interface PlacedNode {
	node: TrafficNode;
	x: number;
	y: number;
	/** Distinct partners this node exchanged messages with in the current window. */
	partners: number;
	messages: number;
	/** Rendered as the hub of its group: a coordinator, or the busiest node in it. */
	hub: boolean;
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

export interface TrafficScene {
	placed: PlacedNode[];
	edges: PlacedEdge[];
	width: number;
	height: number;
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
 */
export function layoutTraffic(
	nodes: TrafficNode[],
	records: TrafficRecord[],
): TrafficScene {
	const byKey = new Map(nodes.map((node) => [node.key, node]));
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
	const hubs = new Set<string>();
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
		hubs.add(group[0]);
		groups.push(group);
	}
	const quiet = nodes.filter((node) => !seen.has(node.key));

	const positions = new Map<string, { x: number; y: number }>();
	const placed: PlacedNode[] = [];
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
		cursorY += (rows + 1) * (CARD_HEIGHT + GAP_Y);
	}
	quiet.forEach((node, index) => {
		place(
			node.key,
			(index % ROW_WIDTH) * step,
			cursorY + Math.floor(index / ROW_WIDTH) * (CARD_HEIGHT + GAP_Y),
			false,
		);
	});
	if (quiet.length) {
		cursorY += Math.ceil(quiet.length / ROW_WIDTH) * (CARD_HEIGHT + GAP_Y);
	}

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
		width: Math.max(width, step),
		height: Math.max(cursorY - GAP_Y, CARD_HEIGHT),
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
	const bus = top.y + CARD_HEIGHT + GAP_Y / 2;
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
