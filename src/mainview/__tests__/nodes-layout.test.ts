import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task } from "../../shared/types";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	layoutTraffic,
	pointAt,
	WIRE_COLORS,
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

	it("keeps the person off the stage: no card of their own and no wire", () => {
		const tasks = [coordinator("a", 11), task("b", 22), task("c", 33)];
		const rows = [
			row(null as unknown as string, "a", { fromSeq: null, origin: "user" }),
			row("a", "b"),
			row("a", "c"),
		];
		const { placed, edges } = scene(tasks, rows);
		// A person has no lifetime on the board, so nothing permanent stands for
		// them: TrafficNodes draws them over the recipient while their message
		// plays, and the grid closes over them again afterwards.
		expect(placed.some((node) => node.node.user)).toBe(false);
		expect(placed).toHaveLength(3);
		expect(edges.map((edge) => [edge.from, edge.to].join(" → ")).some((pair) => pair.includes("dev3:user"))).toBe(false);
		// The coordinator is back at the top of its own grid, nothing above it.
		const hub = placed.find((node) => node.hub)!;
		for (const other of placed.filter((node) => !node.hub)) {
			expect(other.y).toBeGreaterThan(hub.y);
		}
		expect(hub.y).toBe(0);
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
		// The coordinator is wider, never shorter — it draws the same rows, so a
		// smaller box clipped its title and overview mid-line.
		expect(placed[0]).toMatchObject({ width: 370, height: CARD_HEIGHT });
		expect(placed[1]).toMatchObject({ width: CARD_WIDTH, height: CARD_HEIGHT });
		expect(CARD_WIDTH).toBe(300);
		expect(CARD_HEIGHT).toBe(234);
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
			// Ports fan out across the card edge now, so the x is a lane, not the centre.
			const last = edge.points[edge.points.length - 1];
			expect(edge.points[0].y).toBe(sender.y);
			expect(edge.points[0].x).toBeGreaterThan(sender.x);
			expect(edge.points[0].x).toBeLessThan(sender.x + sender.width);
			expect(last.y).toBe(hub.y + hub.height);
			expect(last.x).toBeGreaterThan(hub.x);
			expect(last.x).toBeLessThan(hub.x + hub.width);
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

	/** Segments of a polyline, as axis-aligned runs, for overlap comparisons. */
	function runs(points: { x: number; y: number }[]) {
		return points.slice(1).map((point, index) => {
			const previous = points[index];
			return point.y === previous.y
				? { axis: "h" as const, at: point.y, from: Math.min(previous.x, point.x), to: Math.max(previous.x, point.x) }
				: { axis: "v" as const, at: point.x, from: Math.min(previous.y, point.y), to: Math.max(previous.y, point.y) };
		});
	}

	/** Total length two different wires draw on top of each other. */
	function overlap(result: ReturnType<typeof scene>) {
		const all = result.edges.flatMap((edge) => runs(edge.points).map((run) => ({ ...run, key: edge.key })));
		let total = 0;
		for (let i = 0; i < all.length; i++) {
			for (let j = i + 1; j < all.length; j++) {
				const a = all[i], b = all[j];
				if (a.key === b.key || a.axis !== b.axis || Math.abs(a.at - b.at) > 0.5) continue;
				total += Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
			}
		}
		return total;
	}

	it("gives every wire out of a coordinator its own lane instead of one shared trunk", () => {
		// One row of recipients: ports and bus lines are the whole geometry, so nothing
		// may be drawn on top of anything.
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 5 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map((t) => row("hub", t.id)));
		expect(result.edges).toHaveLength(5);
		expect(overlap(result)).toBe(0);
		// Distinct ports on the coordinator's bottom edge, and distinct bus lines.
		expect(new Set(result.edges.map((edge) => edge.points[0].x)).size).toBe(5);
		expect(new Set(result.edges.map((edge) => edge.points[1].y)).size).toBe(5);
		expect(new Set(result.edges.map((edge) => edge.lane)).size).toBe(5);
		assertClear(result);
	});

	it("keeps ports and bus lines separate even when wires cross a second row", () => {
		// Reaching the second row means sharing the vertical gaps between the cards of
		// the first, and those channels belong to the router's A*, not to the lane plan.
		// So ports and buses must still be unique, while a bounded amount of shared
		// vertical run is expected — the assertion pins that budget instead of pretending
		// it is zero.
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 8 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map((t) => row("hub", t.id)));
		expect(result.edges).toHaveLength(8);
		expect(new Set(result.edges.map((edge) => edge.points[0].x)).size).toBe(8);
		// A detoured wire's second point is wherever A* took it, so uniqueness is
		// asserted on the ports the lane plan owns, not on the whole polyline.
		expect(new Set(result.edges.map((edge) => edge.points[edge.points.length - 1].x)).size).toBeGreaterThan(1);
		expect(overlap(result)).toBeLessThan(300);
		assertClear(result);
	});

	it("keeps lanes deterministic across identical scenes", () => {
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 6 }, (_, i) => task(`t${i}`, i + 2))];
		const rows = tasks.slice(1).map((t) => row("hub", t.id));
		expect(scene(tasks, rows).edges.map((edge) => edge.points)).toEqual(scene(tasks, rows).edges.map((edge) => edge.points));
	});

	it("assigns a stable wire colour per pair, unchanged when neighbours appear", () => {
		const tasks = [coordinator("hub", 1), task("a", 2), task("b", 3)];
		const two = scene(tasks, [row("hub", "a"), row("hub", "b")]);
		const three = scene([...tasks, task("c", 4)], [row("hub", "a"), row("hub", "b"), row("hub", "c")]);
		const colourOf = (result: ReturnType<typeof scene>, id: string) =>
			result.edges.find((edge) => edge.key.includes(endpointKey("p", id)))!.colorIndex;
		expect(colourOf(two, "a")).toBe(colourOf(three, "a"));
		expect(colourOf(two, "b")).toBe(colourOf(three, "b"));
		for (const edge of three.edges) {
			expect(edge.colorIndex).toBeGreaterThanOrEqual(1);
			expect(edge.colorIndex).toBeLessThanOrEqual(WIRE_COLORS);
		}
	});

	it("still routes every wire when lanes compress in a crowded corridor", () => {
		// 20 wires out of one coordinator: more lanes than the corridor can space out,
		// so the plan compresses. Compression must never drop a wire off the grid.
		const tasks = [coordinator("hub", 1), ...Array.from({ length: 20 }, (_, i) => task(`t${i}`, i + 2))];
		const result = scene(tasks, tasks.slice(1).map((t) => row("hub", t.id)));
		expect(result.edges).toHaveLength(20);
		assertClear(result);
	});

	describe("project grouping", () => {
		const projectTasks = (projectId: string) => [
			task("hub", 10, { projectId, taskType: "coordinator" }),
			task("worker", 1, { projectId }),
			task("quiet", 0, { projectId }),
			task("parked", 2, { projectId, hibernated: true }),
		];
		const projectRows = (projectId: string) => [
			row("hub", "worker", { fromProjectId: projectId, toProjectId: projectId }),
			row("hub", "parked", { fromProjectId: projectId, toProjectId: projectId }),
		];

		it("keeps each project's coordinator and bands inside separate blocks", () => {
			const tasks = ["z", "a", "m"].flatMap(projectTasks);
			const rows = ["m", "z", "a"].flatMap(projectRows);
			const result = scene(tasks, rows);
			expect(result.groups.map(group => group.projectId)).toEqual(["a", "m", "z"]);
			expect(result.groups[0].y).toBe(result.groups[1].y);
			expect(result.groups[1].x).toBeGreaterThan(result.groups[0].x + result.groups[0].width);
			expect(result.groups[2].x).toBe(0);
			expect(result.groups[2].y).toBeGreaterThan(Math.max(...result.groups.slice(0, 2).map(group => group.y + group.height)));
			for (const group of result.groups) {
				const cards = result.placed.filter(card => card.node.projectId === group.projectId);
				expect(cards).toHaveLength(4);
				const hub = cards.find(card => card.node.id === "hub")!;
				for (const card of cards) {
					expect(card.x).toBeGreaterThanOrEqual(group.x);
					expect(card.y).toBeGreaterThanOrEqual(group.y + 96);
					expect(card.x + card.width).toBeLessThanOrEqual(group.x + group.width);
					expect(card.y + card.height).toBeLessThanOrEqual(group.y + group.height);
					if (card !== hub) expect(card.y).toBeGreaterThan(hub.y);
				}
			}
			const reversed = scene([...tasks].reverse(), [...rows].reverse());
			expect(reversed.groups).toEqual(result.groups);
			expect(reversed.placed.map(({ node, x, y }) => [node.key, x, y])).toEqual(result.placed.map(({ node, x, y }) => [node.key, x, y]));
			assertClear(result);
		});

		it("chooses five or six worker columns independently for each project", () => {
			const tasks = [...projectTasks("a"), ...projectTasks("b"), ...Array.from({ length: 25 }, (_, i) => task(`extra${i}`, i + 20, { projectId: "a" })), ...Array.from({ length: 4 }, (_, i) => task(`extraB${i}`, i + 20, { projectId: "b" }))];
			const rows = [...projectRows("a"), ...projectRows("b"), ...tasks.filter(task => task.id.startsWith("extra")).map(task => row("hub", task.id, { fromProjectId: task.projectId, toProjectId: task.projectId }))];
			const result = scene(tasks, rows);
			expect(result.groups[0].width - result.groups[1].width).toBe(352);
			const workers = result.placed.filter(card => card.node.projectId === "a" && !card.hub && !card.parked && card.messages > 0);
			const firstY = Math.min(...workers.map(card => card.y));
			expect(workers.filter(card => card.y === firstY)).toHaveLength(6);
			assertClear(result);
		});

		it("compacts a one-task project beside a coordinator and five workers", () => {
			const tasks = [task("solo", 1, { projectId: "a" }), task("hub", 1, { projectId: "b", taskType: "coordinator" }),
				...Array.from({ length: 5 }, (_, i) => task(`worker${i}`, i + 2, { projectId: "b" }))];
			const rows = [row("", "solo", { fromTaskId: null, fromSeq: null, toProjectId: "a" }),
				...tasks.filter(task => task.id.startsWith("worker")).map(task => row("hub", task.id, { fromProjectId: "b", toProjectId: "b" }))];
			const result = collapsed(tasks, rows);
			expect(result.groups[0].width).toBe(300 + 64);
			expect(result.groups[1].width).toBe(5 * 352 - 52 + 64);
			const workers = result.placed.filter(card => card.node.id.startsWith("worker"));
			expect(new Set(workers.map(card => card.y)).size).toBe(1);
			const hub = result.placed.find(card => card.node.id === "hub")!;
			expect(hub.x + hub.width / 2).toBe((Math.min(...workers.map(card => card.x)) + Math.max(...workers.map(card => card.x + card.width))) / 2);
			assertClear(result);
		});

		it("centers a coordinator above a single worker without clipping its block", () => {
			const result = scene([...projectTasks("a"), ...projectTasks("b")], [...projectRows("a"), ...projectRows("b")]);
			for (const group of result.groups) {
				expect(group.width).toBe(370 + 64);
				const hub = result.placed.find(card => card.node.projectId === group.projectId && card.node.id === "hub")!;
				const worker = result.placed.find(card => card.node.projectId === group.projectId && card.node.id === "worker")!;
				expect(hub.x + hub.width / 2).toBe(worker.x + worker.width / 2);
				expect(hub.x).toBeGreaterThanOrEqual(group.x);
				expect(hub.x + hub.width).toBeLessThanOrEqual(group.x + group.width);
			}
			assertClear(result);
		});

		it("keeps a single project's coordinates free of group padding", () => {
			const result = scene(projectTasks("p"), projectRows("p"));
			expect(result.groups).toEqual([]);
			expect(result.placed.find(card => card.node.id === "hub")).toMatchObject({ x: 669, y: 0 });
			expect(result.placed.find(card => card.node.id === "worker")).toMatchObject({ x: 0, y: 340 });
			expect(result.placed.find(card => card.node.id === "quiet")).toMatchObject({ x: 0, y: 700 });
			expect(result.placed.find(card => card.node.id === "parked")).toMatchObject({ x: 0, y: 1060 });
		});

		it("routes cross-project exchanges around cards including different-height ports", () => {
			const tasks = [...projectTasks("a"), ...Array.from({ length: 6 }, (_, i) => task(`b${i}`, i, { projectId: "b" }))];
			const crossRows = tasks.filter(task => task.projectId === "b").map(task => row("hub", task.id, { fromProjectId: "a", toProjectId: "b" }));
			const result = scene(tasks, [...projectRows("a"), ...crossRows]);
			expect(result.edges).toHaveLength(8);
			const sender = result.placed.find(card => card.node.key === endpointKey("a", "hub"))!;
			const recipient = result.placed.find(card => card.node.key === endpointKey("b", "b0"))!;
			const edge = result.edges.find(edge => edge.to === recipient.node.key)!;
			expect(edge.points[0]).toEqual({ x: sender.x + sender.width, y: sender.y + sender.height * .52 });
			expect(edge.points[edge.points.length - 1]).toEqual({ x: recipient.x, y: recipient.y + recipient.height * .52 });
			assertClear(result);
		});

		// Eligibility keyed on message volume erased a whole project from the stage —
		// group box, cards and all — and took the named group off the surviving
		// project too, since grouping switches on at more than one visible project.
		it("gives a project with no traffic its own named block beside a conversing one", () => {
			const tasks = [...projectTasks("a"), task("solo1", 20, { projectId: "b" }), task("solo2", 21, { projectId: "b" })];
			const result = collapsed(tasks, projectRows("a"));
			expect(result.groups.map(group => group.projectId)).toEqual(["a", "b"]);
			expect(result.placed.map(card => `${card.node.projectId}/${card.node.id}`).sort())
				.toEqual(["a/hub", "a/worker", "b/solo1", "b/solo2"]);
			// No coordinator is invented for the silent project, and its cards are not
			// double-counted by the quiet band that would otherwise have hidden them.
			expect(result.placed.filter(card => card.hub).map(card => card.node.projectId)).toEqual(["a"]);
			expect(result.placed.every(card => card.node.projectId !== "b" || card.messages === 0)).toBe(true);
			expect(result.quietCount).toBe(1);
			assertClear(result);
		});

		// The silent project's tasks are drawn once, whichever way the bands are set.
		it("never draws a promoted task twice when the quiet band opens", () => {
			const tasks = [...projectTasks("a"), task("solo", 20, { projectId: "b" })];
			const result = scene(tasks, projectRows("a"));
			expect(result.placed.filter(card => card.node.id === "solo")).toHaveLength(1);
			expect(result.quietCount).toBe(1);
		});

		// The window's whole traffic decides eligibility, not the replay cursor, so a
		// coordinator arriving mid-replay cannot reshuffle either project's cards.
		it("keeps a silent project's cards in place once the other project goes quiet", () => {
			const tasks = [...projectTasks("a"), task("solo", 20, { projectId: "b" })];
			const withTraffic = collapsed(tasks, projectRows("a"));
			const noTraffic = collapsed(tasks, []);
			expect(noTraffic.groups.map(group => group.projectId)).toEqual(["a", "b"]);
			expect(noTraffic.placed.map(card => card.node.id).sort()).toEqual(["hub", "quiet", "solo", "worker"]);
			expect(withTraffic.placed.find(card => card.node.id === "solo")).toMatchObject({ messages: 0, hub: false });
		});

		// Hibernated and completed tasks keep their existing treatment: neither state
		// earns a project a block of its own.
		it("leaves a project holding only hibernated tasks in the parked band", () => {
			const tasks = [...projectTasks("a"), task("asleep", 20, { projectId: "b", hibernated: true })];
			const result = collapsed(tasks, projectRows("a"));
			expect(result.groups.map(group => group.projectId)).toEqual([]);
			expect(result.placed.every(card => card.node.projectId === "a")).toBe(true);
			expect(result.parkedCount).toBe(2);
		});

		it("keeps single-ended recipients visible and counts every attempt once", () => {
			const tasks = [task("a", 1), task("b", 1, { projectId: "q" })];
			const rows = [row("", "a", { fromTaskId: null, fromSeq: null }),
				row("a", "a"), row("", "b", { fromTaskId: null, fromSeq: null, toProjectId: "q" })];
			const result = collapsed(tasks, rows);
			expect(result.placed).toHaveLength(2);
			expect(result.groups).toHaveLength(2);
			expect(result.quietCount).toBe(0);
			expect(result.edges).toHaveLength(0);
			expect(result.placed.find(card => card.node.id === "a")).toMatchObject({ messages: 2, partners: 0 });
			expect(result.placed.find(card => card.node.id === "b")).toMatchObject({ messages: 1, partners: 0 });
		});
	});

});
