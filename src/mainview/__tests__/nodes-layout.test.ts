import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task } from "../../shared/types";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	layoutTraffic,
	pointAt,
	wirePath,
} from "../components/agent-traffic/nodes-layout";
import { createTrafficRouter } from "../components/agent-traffic/nodes-routing";
import { endpointKey, trafficNodes, trafficRecords } from "../components/agent-traffic/traffic-model";

function task(id: string, seq: number, over: Partial<Task> = {}): Task {
	return {
		id,
		projectId: "p",
		seq,
		title: id,
		status: "in-progress",
		taskType: null,
		...over,
	} as unknown as Task;
}
const coordinator = (id: string, seq: number) => task(id, seq, { taskType: "coordinator" });
const parked = (id: string, seq: number) => task(id, seq, { hibernated: true });

function row(from: string, to: string, over: Partial<AgentMessageLogRow> = {}): AgentMessageLogRow {
	return {
		v: 1,
		at: "2026-09-07T10:00:00.000Z",
		fromTaskId: from,
		fromSeq: 1,
		fromTitle: from,
		toTaskId: to,
		toSeq: 2,
		toTitle: to,
		toProjectId: "p",
		kind: "immediate",
		body: "hello",
		bodyKind: "text",
		status: "delivered",
		...over,
	};
}

/** Bands expanded, which is what the band-specific assertions are about. */
function scene(tasks: Task[], rows: AgentMessageLogRow[]) {
	return layoutTraffic(trafficNodes(tasks, rows), trafficRecords(rows), {
		showQuiet: true,
		showParked: true,
	});
}

/** What the stage actually opens with. */
function collapsed(tasks: Task[], rows: AgentMessageLogRow[]) {
	return layoutTraffic(trafficNodes(tasks, rows), trafficRecords(rows));
}

describe("layoutTraffic", () => {
	it("places the coordinator above the reference card grid", () => {
		const tasks = [coordinator("a", 11), task("b", 22), task("c", 33)];
		const { placed, edges } = scene(tasks, [row("a", "b"), row("a", "c")]);
		const hub = placed.find((node) => node.hub);
		expect(hub?.node.id).toBe("a");
		for (const other of placed.filter((node) => !node.hub)) {
			expect(other.y).toBeGreaterThan(hub?.y as number);
		}
		expect(edges).toHaveLength(2);
	});

	it("places five workers in the first row below the coordinator", () => {
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 6 }, (_, i) => task(`t${i}`, i + 2))];
		const { placed } = scene(tasks, tasks.slice(1).map(t => row("hub", t.id)));
		const workers = placed.filter(node => !node.hub);
		expect(new Set(workers.slice(0, 5).map(node => node.y)).size).toBe(1);
		expect(workers[5].y).toBeGreaterThan(workers[0].y);
		const hub = placed.find(node => node.hub)!;
		expect(hub.x + hub.width / 2).toBe((workers[0].x + workers[4].x + workers[4].width) / 2);
	});

	it("keeps ordinary tasks in a stable grid without assigning a coordinator", () => {
		const tasks = [task("a", 11), task("b", 22), task("c", 33)];
		const first = scene(tasks, [row("b", "a"), row("b", "c")]);
		const next = scene([...tasks].reverse(), [row("c", "a"), row("c", "b")]);
		expect(first.placed.every((node) => !node.hub)).toBe(true);
		expect(first.placed.map(({ node, x, y }) => [node.id, x, y])).toEqual(
			next.placed.map(({ node, x, y }) => [node.id, x, y]),
		);
		expect(new Set(first.placed.map((node) => node.y)).size).toBe(1);
	});

	it("uses overview-sized cards and a wider coordinator", () => {
		const { placed } = scene([coordinator("a", 11), task("b", 22)], [row("a", "b")]);
		expect(placed[0]).toMatchObject({ width: 370, height: 183 });
		expect(placed[1]).toMatchObject({ width: CARD_WIDTH, height: CARD_HEIGHT });
		expect(CARD_WIDTH).toBe(300);
		expect(CARD_HEIGHT).toBe(222);
	});

	it("counts a pair once however many attempts it carries", () => {
		const { edges } = scene([task("a", 11), task("b", 22)], [
			row("a", "b"),
			row("a", "b", { at: "2026-09-07T10:05:00.000Z" }),
			row("b", "a", { at: "2026-09-07T10:06:00.000Z", status: "held" }),
		]);
		expect(edges).toHaveLength(1);
		expect(edges[0].messages).toBe(3);
		// The newest attempt owns the wire's verdict — a pair is only as settled as
		// its last message.
		expect(edges[0].status).toBe("held");
	});

	// A task nobody messaged still exists on the board; dropping it would misreport
	// who is running.
	it("keeps silent tasks on the stage without a wire", () => {
		const { placed, edges } = scene([task("a", 11), task("b", 22), task("z", 99)], [row("a", "b")]);
		const quiet = placed.find((node) => node.node.id === "z");
		expect(quiet).toBeTruthy();
		expect(quiet?.messages).toBe(0);
		expect(edges.every((edge) => ![edge.from, edge.to].includes(endpointKey("p", "z")))).toBe(true);
	});



	// A 43-task board with four messages drew 43 cards and four wires — a census of
	// the board, not its traffic. Both trailing bands now start collapsed, and the
	// counts are still reported so the view can say what it is not drawing.
	it("opens on the conversation alone, but counts what it left out", () => {
		const tasks = [coordinator("a", 11), task("b", 22), task("quiet", 44), parked("z", 99)];
		const scene = collapsed(tasks, [row("a", "b")]);
		expect(scene.placed.map((node) => node.node.id).sort()).toEqual(["a", "b"]);
		expect(scene.quietCount).toBe(1);
		expect(scene.parkedCount).toBe(1);
	});

	// A wire whose far end is not drawn would dangle into nothing.
	it("drops a wire whose endpoint sits in a collapsed band", () => {
		expect(collapsed([coordinator("a", 11), parked("z", 99)], [row("a", "z")]).edges).toHaveLength(0);
	});

	// On a real board most tasks are parked. Mixed into the conversation they bury
	// the handful that is actually running, so they get a band of their own.
	it("sinks hibernated tasks below everything, even ones that messaged", () => {
		const tasks = [coordinator("a", 11), task("b", 22), parked("z", 99)];
		const { placed } = scene(tasks, [row("a", "b"), row("a", "z")]);
		const asleep = placed.find((node) => node.node.id === "z");
		expect(asleep?.parked).toBe(true);
		for (const other of placed.filter((node) => node.node.id !== "z")) {
			expect(asleep?.y).toBeGreaterThan(other.y);
			expect(other.parked).toBe(false);
		}
	});

	// The wire survives the move: the history is still true, the card just stops
	// competing for attention.
	it("still draws a hibernated task's wires from its band", () => {
		const { edges } = scene([coordinator("a", 11), parked("z", 99)], [row("a", "z")]);
		expect(edges).toHaveLength(1);
	});

	// A parked task must never become the hub of a group it was pulled out of.
	it("never makes a hibernated task a hub", () => {
		const tasks = [task("a", 11), task("b", 22), parked("z", 99)];
		const { placed } = scene(tasks, [row("z", "a"), row("z", "b"), row("a", "b")]);
		expect(placed.find((node) => node.hub)?.node.id).not.toBe("z");
	});

	it.each([9, 16, 28, 100])("never overlaps cards on a %i-task board", (count) => {
		const tasks = Array.from({ length: count }, (_, index) =>
			index < 3 ? coordinator(`t${index}`, index + 1) : task(`t${index}`, index + 1),
		);
		const { placed, width, height } = scene(tasks, tasks.slice(1).map((other) => row("t0", other.id)));
		for (const a of placed) {
			expect(a.x).toBeGreaterThanOrEqual(0);
			expect(a.x + a.width).toBeLessThanOrEqual(width);
			expect(a.y + a.height).toBeLessThanOrEqual(height);
			for (const b of placed) {
				if (a === b) continue;
				const apart = a.x + a.width <= b.x || b.x + b.width <= a.x ||
					a.y + a.height <= b.y || b.y + b.height <= a.y;
				expect(apart).toBe(true);
			}
		}
	});

	it("starts an upward reply at its sender and ends at the coordinator", () => {
		const { placed, edges } = scene([coordinator("a", 11), task("b", 22)], [row("b", "a")]);
		const sender = placed.find((node) => node.node.id === "b")!;
		const recipient = placed.find((node) => node.node.id === "a")!;
		expect(pointAt(edges[0].points, 0)).toEqual({ x: sender.x + sender.width / 2, y: sender.y });
		expect(pointAt(edges[0].points, 1)).toEqual({ x: recipient.x + recipient.width / 2, y: recipient.y + recipient.height });
	});

	it("connects neighboring cards at their facing sides in the recorded direction", () => {
		const { placed, edges } = scene([task("a", 11), task("b", 22)], [row("b", "a")]);
		const [recipient, sender] = placed;
		expect(edges[0].points).toEqual([
			{ x: sender.x, y: sender.y + sender.height * 0.52 },
			{ x: recipient.x + recipient.width, y: recipient.y + recipient.height * 0.52 },
		]);
	});

	it("keeps completed endpoints in their conversation with their board status", () => {
		const { placed, edges } = collapsed([coordinator("a", 11), task("done", 22, { status: "completed" })], [row("done", "a")]);
		expect(placed.find((node) => node.node.id === "done")?.node.task?.status).toBe("completed");
		expect(edges).toHaveLength(1);
	});

});

describe("wire geometry", () => {
	const points = [
		{ x: 0, y: 0 },
		{ x: 0, y: 100 },
		{ x: 200, y: 100 },
		{ x: 200, y: 200 },
	];

	it("rounds every corner and still starts and ends on the polyline", () => {
		const path = wirePath(points);
		expect(path.startsWith("M 0 0")).toBe(true);
		expect(path.endsWith("L 200 200")).toBe(true);
		expect(path.split("Q")).toHaveLength(3);
	});

	// The dot's position comes from arithmetic, not from an SVG measurement — which
	// is what lets the flight animate identically in a test and in a browser.
	it("walks a message from one end of the wire to the other", () => {
		expect(pointAt(points, 0)).toEqual({ x: 0, y: 0 });
		expect(pointAt(points, 1)).toEqual({ x: 200, y: 200 });
		const middle = pointAt(points, 0.5);
		expect(middle.y).toBe(100);
		expect(middle.x).toBeGreaterThan(0);
		expect(middle.x).toBeLessThan(200);
	});

	it("clamps a progress value that ran past its flight", () => {
		expect(pointAt(points, 2)).toEqual({ x: 200, y: 200 });
		expect(pointAt(points, -1)).toEqual({ x: 0, y: 0 });
	});
});


describe("obstacle-aware traffic routing", () => {
	function assertClear(result: ReturnType<typeof scene>) {
		for (const edge of result.edges) {
			for (let index = 1; index < edge.points.length; index++) {
				const a = edge.points[index - 1], b = edge.points[index];
				expect(a.x === b.x || a.y === b.y).toBe(true);
				for (const card of result.placed) {
					const endpoint = card.node.key === edge.from || card.node.key === edge.to;
					const pad = endpoint ? 0 : 14;
					const left = card.x - pad, right = card.x + card.width + pad;
					const top = card.y - pad, bottom = card.y + card.height + pad;
					const crossing = a.x === b.x
						? a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom
						: a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
					if (crossing) throw new Error(`${edge.from} → ${edge.to} crosses ${card.node.id}`);
				}
			}
		}
	}

	it("routes a same-row exchange around the intervening card", () => {
		const tasks = [task("a", 1), task("b", 2), task("c", 3)];
		const result = scene(tasks, [row("a", "b"), row("a", "c")]);
		expect(result.edges).toHaveLength(2);
		const edge = result.edges.find(edge => edge.to === endpointKey("p", "c"))!;
		expect(edge.points.length).toBeGreaterThan(2);
		assertClear(result);
	});

	it("routes a coordinator exchange past several occupied rows", () => {
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 12 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map(t => row("hub", t.id)));
		expect(result.edges).toHaveLength(12);
		assertClear(result);
	});

	it("preserves sender direction when a reply needs a detour", () => {
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 12 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map(t => row(t.id, "hub")));
		expect(result.edges).toHaveLength(12);
		const hub = result.placed.find(p => p.node.id === "hub")!;
		for (const edge of result.edges) {
			const sender = result.placed.find(p => p.node.key === edge.from)!;
			expect(edge.points[0]).toEqual({ x: sender.x + sender.width / 2, y: sender.y });
			expect(edge.points[edge.points.length - 1]).toEqual({ x: hub.x + hub.width / 2, y: hub.y + hub.height });
		}
		assertClear(result);
	});

	it("keeps dense traffic clear of active, completed, quiet and parked cards", () => {
		const tasks = Array.from({ length: 100 }, (_, i) => i < 2 ? coordinator(`t${i}`, i) :
			task(`t${i}`, i, { hibernated: i >= 80, status: i % 7 === 0 ? "completed" : "in-progress" }));
		const rows = tasks.slice(1, 90).flatMap((t, i) => [row("t0", t.id), row(t.id, `t${(i * 17 + 7) % 90}`)]).filter(r => r.fromTaskId !== r.toTaskId);
		const result = scene(tasks, rows);
		const pairs = new Set(rows.map(r => [r.fromTaskId, r.toTaskId].sort().join("|")));
		expect(result.edges).toHaveLength(pairs.size);
		expect(result.placed).toHaveLength(100);
		assertClear(result);
	});

	it("finds a deterministic shortest Manhattan detour", () => {
		const source = { x: 0, y: 0, width: 100, height: 100 };
		const obstacle = { x: 152, y: 0, width: 100, height: 100 };
		const target = { x: 304, y: 0, width: 100, height: 100 };
		const route = createTrafficRouter([source, obstacle, target]);
		const preferred = [{ x: 100, y: 52 }, { x: 304, y: 52 }];
		const points = route(preferred, source, target)!;
		expect(points).not.toBeNull();
		expect(route(preferred, source, target)).toEqual(points);
		const length = points.slice(1).reduce((total, p, i) => total + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y), 0);
		expect(length).toBe(204 + 2 * 74);
	});

	it("keeps the rendered rounded corners clear of every card", () => {
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 9 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map(t => row("hub", t.id)));
		for (const edge of result.edges) {
			let cursor = edge.points[0];
			for (const command of wirePath(edge.points).matchAll(/([MLQ])([^MLQ]+)/g)) {
				const values = command[2].trim().split(/\s+/).map(Number);
				if (command[1] !== "Q") { cursor = { x: values[0], y: values[1] }; continue; }
				const [cx, cy, x, y] = values;
				for (let step = 0; step <= 20; step++) {
					const t = step / 20, inverse = 1 - t;
					const point = { x: inverse * inverse * cursor.x + 2 * inverse * t * cx + t * t * x,
						y: inverse * inverse * cursor.y + 2 * inverse * t * cy + t * t * y };
					for (const card of result.placed) {
						const pad = card.node.key === edge.from || card.node.key === edge.to ? 0 : 14;
						if (point.x > card.x - pad && point.x < card.x + card.width + pad &&
							point.y > card.y - pad && point.y < card.y + card.height + pad) throw new Error(`Rounded route intersects ${card.node.id}`);
					}
				}
				cursor = { x, y };
			}
		}
	});

	it("omits a route whose sender port is obstructed instead of crossing a card", () => {
		const source = { x: 0, y: 0, width: 100, height: 100 };
		const blocker = { x: 105, y: 0, width: 100, height: 100 };
		const target = { x: 304, y: 0, width: 100, height: 100 };
		const route = createTrafficRouter([source, blocker, target]);
		expect(route([{ x: 100, y: 52 }, { x: 304, y: 52 }], source, target)).toBeNull();
	});
});
