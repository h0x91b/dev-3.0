import type { KanbanOrder } from "./kanban-order";
import { createTrafficRouter } from "./nodes-routing";
import { baseBus, laneGridLines, planLanes, type LanePlan } from "./wire-lanes";
import { fromKey, toKey, type TrafficNode, type TrafficRecord } from "./traffic-model";

/** Card footprint and the gaps between cards, in scene units (= CSS px at scale 1). */
export const CARD_WIDTH = 300;
/** Tall enough for every row the card draws (head, two title lines, state,
 *  three overview lines, last message) without clipping one mid-glyph. */
export const CARD_HEIGHT = 234;
const COORDINATOR_WIDTH = 370;
const COORDINATOR_HEIGHT = CARD_HEIGHT;
const GAP_X = 52;
const ROW_STEP = 360;
const COORDINATOR_STEP = 340;
/** What a node occupies on the stage. */
function footprint(node: TrafficNode): { width: number; height: number } {
	return node.task?.taskType === "coordinator"
		? { width: COORDINATOR_WIDTH, height: COORDINATOR_HEIGHT }
		: { width: CARD_WIDTH, height: CARD_HEIGHT };
}

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
	/** Lane this wire took in its corridor; 0 when it is alone there. */
	lane: number;
	/** 1..WIRE_COLORS — which --wire-N token paints it. Stable per pair. */
	colorIndex: number;
	lastAt: number;
	subject: string;
}

export interface TrafficScene {
	placed: PlacedNode[];
	edges: PlacedEdge[];
	groups: { projectId: string; x: number; y: number; width: number; height: number }[];
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
	/**
	 * Board column order, from [[kanbanOrder]]. Absent = plain seq order, which is
	 * what a caller with no project list (and the layout's own unit tests) gets.
	 */
	board?: KanbanOrder;
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

/** Cards that go in the grid, as opposed to the coordinator above it. */
const isWorker = (node: TrafficNode) => node.task?.taskType !== "coordinator";

/**
 * Message volume never moves a card: the order is the board's column order (when
 * `options.board` is given) and then seq, so a busy task cannot climb the stage.
 * The board column is read at the replay cursor, so scrubbing back does move a
 * card that has since been completed back to where it actually was.
 */
export function layoutTraffic(
	allNodes: TrafficNode[],
	records: TrafficRecord[],
	options: SceneOptions = {},
): TrafficScene {
	// The person never takes a place on the stage. They are not a work item with
	// a lifetime: they appear over whichever task they just wrote to, say their
	// piece and are gone, so a permanent marker and a permanent fan of wires from
	// it would both claim a presence that does not exist. TrafficNodes draws that
	// appearance transiently, from the message that is playing.
	const nodes = allNodes.filter((node) => !node.user);
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
		}
	}

	for (const { row } of records) {
		for (const key of new Set([fromKey(row), toKey(row)])) {
			if (key && byKey.has(key)) messages.set(key, (messages.get(key) ?? 0) + 1);
		}
	}

	const board = options.board;
	// To Do is board backlog, not conversation, so it never reaches the stage — a
	// message it exchanged does not buy it a card. Its wires go with it: an edge
	// needs BOTH endpoints placed, so nothing is left dangling. Hidden here only —
	// the message log and the replay timeline keep every row either way.
	const eligible = board ? nodes.filter(node => !board.todo(node)) : nodes;
	const sorted = [...eligible].sort((a, b) =>
		(board ? board.rank(a) - board.rank(b) : 0) ||
		(a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
		a.key.localeCompare(b.key),
	);
	const parked = sorted.filter((node) => node.task?.hibernated === true);
	const awake = sorted.filter((node) => !node.task?.hibernated);
	// Eligibility is per project, not per message count: a project whose window
	// holds zero messages still gets its block. Volume decides which cards a
	// *conversation* buries, never whether a board exists — the old zero-message
	// rule erased a whole board from the stage, group box and all.
	const silent = new Set(awake.map((node) => node.projectId));
	for (const node of awake) if (messages.has(node.key)) silent.delete(node.projectId);
	const conversing = (node: TrafficNode) => messages.has(node.key) || silent.has(node.projectId);
	const active = awake.filter(conversing);
	const quiet = awake.filter((node) => !conversing(node));
	const placed: PlacedNode[] = [];
	const positions = new Map<string, PlacedNode>();
	const groups: TrafficScene["groups"] = [];
	const visible = [...active, ...(options.showQuiet ? quiet : []), ...(options.showParked ? parked : [])];
	const projectIds = [...new Set(visible.map(node => node.projectId))].sort();
	const grouped = projectIds.length > 1;
	let width = 0;
	let height = 0;
	let groupX = 0;
	let groupY = 0;
	let groupRowHeight = 0;
	const place = (node: TrafficNode, x: number, y: number) => {
		const coordinator = node.task?.taskType === "coordinator";
		const position: PlacedNode = {
			node, x, y,
			...footprint(node),
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
	projectIds.forEach((projectId, projectIndex) => {
		const projectActive = active.filter(node => node.projectId === projectId);
		const projectQuiet = quiet.filter(node => node.projectId === projectId);
		const projectParked = parked.filter(node => node.projectId === projectId);
		const normalCount = projectActive.filter(isWorker).length;
		const columns = normalCount > 24 ? 6 : 5;
		const bands = [projectActive, ...(options.showQuiet ? [projectQuiet] : []), ...(options.showParked ? [projectParked] : [])];
		const occupiedColumns = grouped
			? Math.min(columns, Math.max(...bands.map(members => members.filter(isWorker).length)))
			: columns;
		const workerWidth = occupiedColumns ? occupiedColumns * (CARD_WIDTH + GAP_X) - GAP_X : 0;
		const hasCoordinator = bands.some(members => members.some(node => node.task?.taskType === "coordinator"));
		const gridWidth = Math.max(workerWidth, hasCoordinator ? COORDINATOR_WIDTH : 0);
		const workerOffset = grouped ? (gridWidth - workerWidth) / 2 : 0;
		const offsetX = grouped ? groupX + 32 : 0;
		const offsetY = grouped ? groupY + 96 : 0;
		let cursorY = 0;
		let contentHeight = 0;
		const add = (node: TrafficNode, x: number, y: number) => {
			place(node, offsetX + x, offsetY + y);
			contentHeight = Math.max(contentHeight, y + footprint(node).height + 28);
		};
		const band = (members: TrafficNode[]) => {
			const coordinators = members.filter(node => node.task?.taskType === "coordinator");
			const normal = members.filter(isWorker);
			for (const node of coordinators) {
				add(node, (gridWidth - COORDINATOR_WIDTH) / 2, cursorY);
				cursorY += COORDINATOR_STEP;
			}
			normal.forEach((node, index) => {
				add(node, workerOffset + (index % columns) * (CARD_WIDTH + GAP_X), cursorY + Math.floor(index / columns) * ROW_STEP);
			});
			cursorY += Math.ceil(normal.length / columns) * ROW_STEP;
		};
		for (const members of bands) band(members);
		if (grouped) {
			const group = { projectId, x: groupX, y: groupY, width: gridWidth + 64, height: contentHeight + 128 };
			groups.push(group);
			width = Math.max(width, group.x + group.width);
			height = Math.max(height, group.y + group.height);
			groupRowHeight = Math.max(groupRowHeight, group.height);
			if (projectIndex % 2 === 0) groupX += group.width + 160;
			else {
				groupX = 0;
				groupY += groupRowHeight + 160;
				groupRowHeight = 0;
			}
		}
	});

	const edges: PlacedEdge[] = [];
	const routable: { key: string; pair: PairState; a: PlacedNode; b: PlacedNode }[] = [];
	for (const [key, pair] of state) {
		const a = positions.get(pair.from);
		const b = positions.get(pair.to);
		if (a && b) routable.push({ key, pair, a, b });
	}
	// Lanes are planned across the whole scene before routing: a wire's port and bus
	// depend on how many neighbours share them, and the router's grid has to know
	// every lane coordinate up front or a fanned-out wire falls off the grid.
	const lanes = planLanes(routable.map(({ key, a, b }) => ({ key, a, b })));
	const route = createTrafficRouter(placed, laneGridLines(lanes));
	for (const { key, pair, a, b } of routable) {
		const points = route(wire(a, b, lanes.get(key)), a, b);
		// A blocked endpoint never gets an unsafe straight-line fallback.
		if (!points) continue;
		edges.push({ key, ...pair, points, lane: lanes.get(key)?.lane ?? 0, colorIndex: wireColorIndex(key) });
	}
	return {
		placed, edges, groups,
		width: Math.max(width, CARD_WIDTH),
		height: Math.max(height, CARD_HEIGHT),
		quietCount: quiet.length,
		parkedCount: parked.length,
	};
}

/** Routes retain sender-to-recipient direction even when the sender is below. */
function wire(a: PlacedNode, b: PlacedNode, plan?: LanePlan): { x: number; y: number }[] {
	if (Math.abs(a.y - b.y) < 30) {
		const right = b.x > a.x;
		const start = { x: a.x + (right ? a.width : 0), y: a.y + a.height * 0.52 };
		const end = { x: b.x + (right ? 0 : b.width), y: b.y + b.height * 0.52 };
		if (start.y === end.y) return [start, end];
		const middle = (start.x + end.x) / 2;
		return [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
	}
	const down = b.y > a.y;
	const [top, bottom] = down ? [a, b] : [b, a];
	const start = { x: plan?.exitX ?? top.x + top.width / 2, y: top.y + top.height };
	const end = { x: plan?.entryX ?? bottom.x + bottom.width / 2, y: bottom.y };
	const bus = plan?.bus ?? baseBus(top, bottom);
	const points = [start, { x: start.x, y: bus }, { x: end.x, y: bus }, end];
	return down ? points : points.reverse();
}

/** How many --wire-N tokens index.css defines, in both themes. */
export const WIRE_COLORS = 16;

/** FNV-1a over the pair key: a connection keeps its colour as neighbours come and go. */
export function wireColorIndex(key: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return (hash % WIRE_COLORS) + 1;
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
