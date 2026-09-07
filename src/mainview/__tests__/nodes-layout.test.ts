import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task } from "../../shared/types";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	layoutTraffic,
	pointAt,
	wirePath,
} from "../components/agent-traffic/nodes-layout";
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
	it("leads a conversation with its coordinator and hangs the rest below", () => {
		const tasks = [coordinator("a", 11), task("b", 22), task("c", 33)];
		const { placed, edges } = scene(tasks, [row("a", "b"), row("a", "c")]);
		const hub = placed.find((node) => node.hub);
		expect(hub?.node.id).toBe("a");
		for (const other of placed.filter((node) => !node.hub)) {
			expect(other.y).toBeGreaterThan(hub?.y as number);
		}
		expect(edges).toHaveLength(2);
	});

	// No coordinator on the board is normal; the busiest task leads instead so the
	// graph still reads as a conversation rather than a scatter of cards.
	it("falls back to the busiest task when nothing is a coordinator", () => {
		const tasks = [task("a", 11), task("b", 22), task("c", 33)];
		const { placed } = scene(tasks, [row("b", "a"), row("b", "c")]);
		expect(placed.find((node) => node.hub)?.node.id).toBe("b");
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

	it("never overlaps two cards", () => {
		const tasks = Array.from({ length: 9 }, (_, index) =>
			index === 0 ? coordinator("t0", 1) : task(`t${index}`, index + 1),
		);
		const { placed } = scene(
			tasks,
			tasks.slice(1).map((other) => row("t0", other.id)),
		);
		for (const a of placed) {
			for (const b of placed) {
				if (a === b) continue;
				const apart =
					Math.abs(a.x - b.x) >= CARD_WIDTH || Math.abs(a.y - b.y) >= CARD_HEIGHT;
				expect(apart).toBe(true);
			}
		}
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
