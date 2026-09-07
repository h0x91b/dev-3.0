import { createTrafficRouter } from "./nodes-routing";
import { fromKey, toKey, type TrafficNode, type TrafficRecord } from "./traffic-model";

/** Card footprint and the gaps between cards, in scene units (= CSS px at scale 1). */
export const CARD_WIDTH = 300;
export const CARD_HEIGHT = 222;
const COORDINATOR_WIDTH = 370;
const COORDINATOR_HEIGHT = 183;
const GAP_X = 52;
const ROW_STEP = 360;
const COORDINATOR_STEP = 340;

export interface PlacedNode {
	node: TrafficNode;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Distinct partners this node exchanged messages with in the current window. */
	partners: number;
	messages: number;
	/** Coordinator presentation; message volume never assigns a task this role. */
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

export interface TrafficScene {
	placed: PlacedNode[];
	edges: PlacedEdge[];
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

/** Stable task ordering keeps replay and new message volume from moving cards. */
export function layoutTraffic(
	nodes: TrafficNode[],
	records: TrafficRecord[],
	options: SceneOptions = {},
): TrafficScene {
	const byKey = new Map(nodes.map((node) => [node.key, node]));
	const state = pairs(records);
	const partners = new Map<string, Set<string>>();
	const messages = new Map<string, number>();
	for (const pair of state.values()) {
		for (const [self, other] of [[pair.from, pair.to], [pair.to, pair.from]]) {
			if (!byKey.has(self)) continue;
			const set = partners.get(self) ?? new Set<string>();
			set.add(other);
			partners.set(self, set);
			messages.set(self, (messages.get(self) ?? 0) + pair.messages);
		}
	}

	const sorted = [...nodes].sort((a, b) =>
		(a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
		a.key.localeCompare(b.key),
	);
	const parked = sorted.filter((node) => node.task?.hibernated === true);
	const awake = sorted.filter((node) => !node.task?.hibernated);
	const active = awake.filter((node) => partners.has(node.key));
	const quiet = awake.filter((node) => !partners.has(node.key));
	const normalCount = active.filter((node) => node.task?.taskType !== "coordinator").length;
	const columns = normalCount > 24 ? 6 : 5;
	const gridWidth = columns * (CARD_WIDTH + GAP_X) - GAP_X;
	const placed: PlacedNode[] = [];
	const positions = new Map<string, PlacedNode>();
	let cursorY = 0;
	let width = 0;
	let height = 0;
	const place = (node: TrafficNode, x: number, y: number) => {
		const coordinator = node.task?.taskType === "coordinator";
		const position: PlacedNode = {
			node, x, y,
			width: coordinator ? COORDINATOR_WIDTH : CARD_WIDTH,
			height: coordinator ? COORDINATOR_HEIGHT : CARD_HEIGHT,
			partners: partners.get(node.key)?.size ?? 0,
			messages: messages.get(node.key) ?? 0,
			hub: coordinator && !node.task?.hibernated,
			parked: node.task?.hibernated === true,
		};
		placed.push(position);
		positions.set(node.key, position);
		width = Math.max(width, x + position.width);
		height = Math.max(height, y + position.height + 28);
	};
	const band = (members: TrafficNode[]) => {
		const coordinators = members.filter((node) => node.task?.taskType === "coordinator");
		const normal = members.filter((node) => node.task?.taskType !== "coordinator");
		for (const node of coordinators) {
			place(node, (gridWidth - COORDINATOR_WIDTH) / 2, cursorY);
			cursorY += COORDINATOR_STEP;
		}
		normal.forEach((node, index) => {
			place(node, (index % columns) * (CARD_WIDTH + GAP_X), cursorY + Math.floor(index / columns) * ROW_STEP);
		});
		cursorY += Math.ceil(normal.length / columns) * ROW_STEP;
	};
	band(active);
	if (options.showQuiet) band(quiet);
	if (options.showParked) band(parked);

	const edges: PlacedEdge[] = [];
	const route = createTrafficRouter(placed);
	for (const [key, pair] of state) {
		const a = positions.get(pair.from);
		const b = positions.get(pair.to);
		if (!a || !b) continue;
		const points = route(wire(a, b), a, b);
		// A blocked endpoint never gets an unsafe straight-line fallback.
		if (!points) continue;
		edges.push({ key, ...pair, points });
	}
	return {
		placed, edges,
		width: Math.max(width, CARD_WIDTH),
		height: Math.max(height, CARD_HEIGHT),
		quietCount: quiet.length,
		parkedCount: parked.length,
	};
}

/** Routes retain sender-to-recipient direction even when the sender is below. */
function wire(a: PlacedNode, b: PlacedNode): { x: number; y: number }[] {
	if (Math.abs(a.y - b.y) < 30) {
		const right = b.x > a.x;
		return [
			{ x: a.x + (right ? a.width : 0), y: a.y + a.height * 0.52 },
			{ x: b.x + (right ? 0 : b.width), y: b.y + b.height * 0.52 },
		];
	}
	const down = b.y > a.y;
	const [top, bottom] = down ? [a, b] : [b, a];
	const start = { x: top.x + top.width / 2, y: top.y + top.height };
	const end = { x: bottom.x + bottom.width / 2, y: bottom.y };
	const bus = top.node.task?.taskType === "coordinator"
		? Math.min(end.y - 38, start.y + 54)
		: (start.y + end.y) / 2;
	const points = [start, { x: start.x, y: bus }, { x: end.x, y: bus }, end];
	return down ? points : points.reverse();
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
