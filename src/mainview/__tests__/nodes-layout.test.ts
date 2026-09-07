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

function task(id: string, seq: number, coordinator = false): Task {
	return {
		id,
		projectId: "p",
		seq,
		title: id,
		status: "in-progress",
		taskType: coordinator ? "coordinator" : null,
	} as unknown as Task;
}

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

function scene(tasks: Task[], rows: AgentMessageLogRow[]) {
	return layoutTraffic(trafficNodes(tasks, rows), trafficRecords(rows));
}

describe("layoutTraffic", () => {
	it("leads a conversation with its coordinator and hangs the rest below", () => {
		const tasks = [task("a", 11, true), task("b", 22), task("c", 33)];
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

	it("never overlaps two cards", () => {
		const tasks = Array.from({ length: 9 }, (_, index) => task(`t${index}`, index + 1, index === 0));
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
