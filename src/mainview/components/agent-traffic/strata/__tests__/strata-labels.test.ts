import { describe, expect, it } from "vitest";
import type { Task } from "../../../../../shared/types";
import { endpointKey } from "../../traffic-model";
import { labelBudget, labelRank, placeLabels, type Rect } from "../strata-labels";
import type { StrataMachine } from "../strata-model";

function machine(overrides: Partial<StrataMachine> & { seq: number }): StrataMachine {
	const task = {
		id: `task-${overrides.seq}`,
		projectId: "proj",
		seq: overrides.seq,
		title: `Task ${overrides.seq}`,
		status: "in-progress",
	} as Task;
	return {
		key: endpointKey("proj", task.id),
		node: { key: endpointKey("proj", task.id), projectId: "proj", id: task.id, seq: overrides.seq, title: task.title, task },
		districtId: "proj",
		pos: [0, 0, 0],
		role: "worker",
		projection: { present: true, status: "in-progress", columnId: null, confidence: "recorded" },
		status: "in-progress",
		hibernated: false,
		unborn: false,
		undelivered: false,
		recordedStages: 1,
		messageCount: 0,
		...overrides,
	};
}

const STAGE = { width: 1400, height: 800 };
const size = { w: 160, h: 30 };

function place(input: {
	machines: StrataMachine[];
	points: Record<string, { x: number; y: number; visible?: boolean }>;
	selected?: string | null;
	reserved?: Rect[];
	width?: number;
}) {
	return placeLabels({
		machines: input.machines,
		selected: input.selected ?? null,
		points: new Map(
			Object.entries(input.points).map(([key, point]) => [
				key,
				{ x: point.x, y: point.y, visible: point.visible ?? true },
			]),
		),
		sizes: new Map(input.machines.map((m) => [m.key, size])),
		width: input.width ?? STAGE.width,
		height: STAGE.height,
		reserved: input.reserved ?? [],
	});
}

describe("labelRank", () => {
	it("puts what is asking for something above what is merely busy", () => {
		const undelivered = machine({ seq: 1, undelivered: true });
		const asking = machine({ seq: 2, status: "user-questions" });
		const coordinator = machine({ seq: 3, role: "coordinator" });
		const working = machine({ seq: 4 });
		const ranked = [working, coordinator, asking, undelivered]
			.sort((a, b) => labelRank(b, null) - labelRank(a, null))
			.map((m) => m.node.seq);
		expect(ranked).toEqual([1, 2, 3, 4]);
	});

	it("puts the selected card above everything, whatever its state", () => {
		const dull = machine({ seq: 1, status: "todo" });
		const urgent = machine({ seq: 2, undelivered: true });
		expect(labelRank(dull, dull.key)).toBeGreaterThan(labelRank(urgent, dull.key));
	});

	it("breaks ties by seq rather than by chance", () => {
		const a = machine({ seq: 10 });
		const b = machine({ seq: 20 });
		expect(labelRank(a, null)).not.toBe(labelRank(b, null));
	});
});

describe("labelBudget", () => {
	it("shows fewer labels on a narrower stage", () => {
		expect(labelBudget(400)).toBeLessThan(labelBudget(700));
		expect(labelBudget(700)).toBeLessThan(labelBudget(1000));
		expect(labelBudget(1000)).toBeLessThan(labelBudget(1600));
	});
});

describe("placeLabels", () => {
	it("drops a label that would land on a reserved overlay panel, never moves it", () => {
		const one = machine({ seq: 1 });
		const panel: Rect = { x: 0, y: 0, w: 400, h: 200 };
		const placed = place({
			machines: [one],
			points: { [one.key]: { x: 200, y: 150 } },
			reserved: [panel],
		});
		expect(placed).toHaveLength(0);
	});

	it("keeps the selected label even on top of a panel — the user asked for it", () => {
		const one = machine({ seq: 1 });
		const placed = place({
			machines: [one],
			points: { [one.key]: { x: 200, y: 150 } },
			selected: one.key,
			reserved: [{ x: 0, y: 0, w: 1400, h: 800 }],
		});
		expect(placed).toHaveLength(1);
		expect(placed[0].key).toBe(one.key);
	});

	it("drops the lower-ranked of two labels that would collide", () => {
		const urgent = machine({ seq: 1, undelivered: true });
		const dull = machine({ seq: 2 });
		const placed = place({
			machines: [dull, urgent],
			points: {
				[urgent.key]: { x: 500, y: 400 },
				[dull.key]: { x: 505, y: 402 },
			},
		});
		expect(placed.map((label) => label.key)).toEqual([urgent.key]);
	});

	it("keeps two labels that clear each other by more than the gap", () => {
		const a = machine({ seq: 1 });
		const b = machine({ seq: 2 });
		const placed = place({
			machines: [a, b],
			points: { [a.key]: { x: 300, y: 400 }, [b.key]: { x: 300, y: 500 } },
		});
		expect(placed).toHaveLength(2);
	});

	it("drops a label that is close enough to touch, even without real overlap", () => {
		const a = machine({ seq: 1, undelivered: true });
		const b = machine({ seq: 2 });
		// 31px apart vertically against a 30px-tall label: no overlap, 1px of gap.
		const placed = place({
			machines: [a, b],
			points: { [a.key]: { x: 300, y: 400 }, [b.key]: { x: 300, y: 431 } },
		});
		expect(placed.map((label) => label.key)).toEqual([a.key]);
	});

	it("never places a label for a card the cursor proves did not exist", () => {
		const unborn = machine({ seq: 1, unborn: true });
		const placed = place({
			machines: [unborn],
			points: { [unborn.key]: { x: 500, y: 400 } },
		});
		expect(placed).toHaveLength(0);
	});

	it("never places a label projected behind the camera", () => {
		const behind = machine({ seq: 1 });
		const placed = place({
			machines: [behind],
			points: { [behind.key]: { x: 500, y: 400, visible: false } },
		});
		expect(placed).toHaveLength(0);
	});

	it("stops at the budget for the stage width", () => {
		const many = Array.from({ length: 20 }, (_, index) => machine({ seq: index + 1 }));
		const points = Object.fromEntries(
			many.map((m, index) => [m.key, { x: 200 + (index % 4) * 250, y: 120 + Math.floor(index / 4) * 120 }]),
		);
		const wide = place({ machines: many, points, width: 1600 });
		const narrow = place({ machines: many, points, width: 480 });
		expect(wide.length).toBeLessThanOrEqual(labelBudget(1600));
		expect(narrow.length).toBeLessThanOrEqual(labelBudget(480));
		expect(narrow.length).toBeLessThan(wide.length);
	});

	it("keeps the selected label inside the stage instead of dropping it off the edge", () => {
		const edge = machine({ seq: 1 });
		const placed = place({
			machines: [edge],
			points: { [edge.key]: { x: 1395, y: 400 } },
			selected: edge.key,
		});
		expect(placed).toHaveLength(1);
		expect(placed[0].rect.x + placed[0].rect.w).toBeLessThanOrEqual(STAGE.width);
	});
});
