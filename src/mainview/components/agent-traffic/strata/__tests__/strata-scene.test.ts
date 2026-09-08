import { describe, expect, it } from "vitest";
import { STATUS_COLORS, type Task, type TaskStatus } from "../../../../../shared/types";
import { endpointKey, type TrafficRecord } from "../../traffic-model";
import { DARK_MATERIALS } from "../strata-palette";
import { VERTEX_FLOATS } from "../strata-mesh";
import type { StrataDistrict, StrataMachine, StrataRoute } from "../strata-model";
import {
	atCurve,
	buildDistrict,
	buildMachine,
	buildRoutes,
	buildSubstrate,
	curve,
	machineLook,
	sceneBounds,
	sceneExtent,
} from "../strata-scene";
import { MeshBuilder } from "../strata-mesh";

const statusColor = (status: TaskStatus) => STATUS_COLORS[status];

function machine(overrides: Partial<StrataMachine> & { seq: number }): StrataMachine {
	const task = { id: `task-${overrides.seq}`, projectId: "proj", seq: overrides.seq } as Task;
	return {
		key: endpointKey("proj", task.id),
		node: { key: endpointKey("proj", task.id), projectId: "proj", id: task.id, seq: overrides.seq, title: "T", task },
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

function district(overrides: Partial<StrataDistrict> = {}): StrataDistrict {
	return {
		id: "proj",
		name: "Alpha",
		plate: "01",
		center: [0, 0, 0],
		radius: 12,
		color: "#83bdcf",
		quiet: false,
		taskCount: 3,
		messageCount: 4,
		...overrides,
	};
}

function route(overrides: Partial<StrataRoute> & { from: string; to: string }): StrataRoute {
	const record: TrafficRecord = {
		key: "r",
		row: {
			v: 1,
			at: "2026-09-08T11:00:00.000Z",
			fromTaskId: "task-1",
			fromSeq: 1,
			toTaskId: "task-2",
			toSeq: 2,
			toProjectId: "proj",
			kind: "immediate",
			body: "b",
			bodyKind: "text",
			status: "delivered",
		},
	};
	return { key: "k", kind: "delivered", record, count: 1, ...overrides };
}

const vertices = (builder: MeshBuilder) => builder.v.length / VERTEX_FLOATS;

describe("machineLook", () => {
	it("renders an unrecorded status with neutral ink and never substitutes the live one", () => {
		const unknown = machine({ seq: 1, status: null });
		const look = machineLook(unknown, statusColor, DARK_MATERIALS);
		expect(look.accent).toBe(DARK_MATERIALS.unknown);
		expect(look.quiet).toBe(true);
		expect(look.done).toBe(false);
		// The neutral ink must be nothing the status palette can produce, or a
		// reader cannot tell "not known" from a real state.
		expect(Object.values(STATUS_COLORS)).not.toContain(look.accent);
	});

	it("takes a known status straight from the app's own palette", () => {
		const look = machineLook(machine({ seq: 1, status: "user-questions" }), statusColor, DARK_MATERIALS);
		expect(look.accent).toBe(STATUS_COLORS["user-questions"]);
		expect(look.quiet).toBe(false);
	});

	it("reads a finished card as done and a hibernated one as quiet", () => {
		expect(machineLook(machine({ seq: 1, status: "completed" }), statusColor, DARK_MATERIALS).done).toBe(true);
		expect(machineLook(machine({ seq: 1, hibernated: true }), statusColor, DARK_MATERIALS).quiet).toBe(true);
		expect(machineLook(machine({ seq: 1, status: "todo" }), statusColor, DARK_MATERIALS).quiet).toBe(true);
	});
});

describe("sceneBounds", () => {
	it("centres on the districts, not on the world origin", () => {
		const bounds = sceneBounds([
			district({ id: "a", center: [40, 0, 0], radius: 10 }),
			district({ id: "b", center: [60, 0, 0], radius: 10 }),
		]);
		expect(bounds.center[0]).toBeCloseTo(50);
		expect(bounds.center[2]).toBeCloseTo(0);
	});

	it("reaches the far edge of the outermost deck from that centre", () => {
		const bounds = sceneBounds([
			district({ id: "a", center: [0, 0, 0], radius: 10 }),
			district({ id: "b", center: [0, 0, 80], radius: 20 }),
		]);
		for (const item of [
			{ center: [0, 0, 0] as const, radius: 10 },
			{ center: [0, 0, 80] as const, radius: 20 },
		]) {
			const reach =
				Math.hypot(item.center[0] - bounds.center[0], item.center[2] - bounds.center[2]) +
				item.radius;
			expect(bounds.radius).toBeGreaterThanOrEqual(reach - 1e-9);
		}
	});

	it("answers an empty board without dividing by zero", () => {
		const bounds = sceneBounds([]);
		expect(bounds.center).toEqual([0, 0, 0]);
		expect(bounds.radius).toBeGreaterThan(0);
	});

	it("keeps the substrate wider than what the camera frames", () => {
		const districts = [district({ center: [30, 0, 20], radius: 14 })];
		expect(sceneExtent(districts)).toBeGreaterThan(sceneBounds(districts).radius);
	});
});

describe("curve", () => {
	it("rises in the middle and lands on both anchors", () => {
		const points = curve([0, 0, 0], [20, 0, 0]);
		const last = points[points.length - 1];
		expect(points[0]).toEqual([0, 0, 0]);
		// `toBeCloseTo`, not `toEqual`: the sine term contributes a ~5e-16 residue
		// at t = 1, which is arithmetic, not a misplaced endpoint.
		expect(last[0]).toBeCloseTo(20);
		expect(last[1]).toBeCloseTo(0);
		expect(last[2]).toBeCloseTo(0);
		expect(atCurve(points, 0.5)[1]).toBeGreaterThan(1);
	});

	it("clamps a sample past the end instead of reading off the array", () => {
		const points = curve([0, 0, 0], [10, 0, 0]);
		expect(atCurve(points, 5)).not.toContain(Number.NaN);
		expect(atCurve(points, -3)).not.toContain(Number.NaN);
	});
});

describe("buildMachine", () => {
	const materials = DARK_MATERIALS;

	it("builds a different silhouette per recorded role", () => {
		const counts = (["coordinator", "reviewer", "worker"] as const).map((role) => {
			const m = machine({ seq: 1, role });
			return vertices(buildMachine(m, machineLook(m, statusColor, materials), materials, false));
		});
		expect(new Set(counts).size).toBe(3);
	});

	it("adds a mast only for a card whose recorded status is asking the user", () => {
		const asking = machine({ seq: 1, status: "user-questions" });
		const quiet = machine({ seq: 1, status: "in-progress" });
		expect(
			vertices(buildMachine(asking, machineLook(asking, statusColor, materials), materials, false)),
		).toBeGreaterThan(
			vertices(buildMachine(quiet, machineLook(quiet, statusColor, materials), materials, false)),
		);
	});

	it("marks a card the log says a message never reached, twice over", () => {
		// A reviewer gantry tops out at y ≈ 3.35, so anything above 3.7 on it is
		// the marker and nothing else. A worker's antenna reaches 4.0 and would
		// make the same probe meaningless.
		const missed = machine({ seq: 1, role: "reviewer", undelivered: true });
		const fine = machine({ seq: 1, role: "reviewer" });
		const missedMesh = buildMachine(missed, machineLook(missed, statusColor, materials), materials, false);
		const fineMesh = buildMachine(fine, machineLook(fine, statusColor, materials), materials, false);
		// The cross sits at y ≈ 3.77, well above anything a worker shed reaches.
		const above = (builder: MeshBuilder) => {
			let count = 0;
			for (let i = 1; i < builder.v.length; i += VERTEX_FLOATS) {
				if (builder.v[i] > 3.7) count++;
			}
			return count;
		};
		expect(above(missedMesh)).toBeGreaterThan(0);
		expect(above(fineMesh)).toBe(0);
		// And the status halo is a shorter arc, which is why the undelivered mesh
		// is the SMALLER of the two — a vertex count would read backwards here.
		expect(vertices(missedMesh)).toBeLessThan(vertices(fineMesh));
	});

	it("collapses to far detail when asked, and stays far cheaper than near", () => {
		const m = machine({ seq: 1 });
		const look = machineLook(m, statusColor, materials);
		const far = vertices(buildMachine(m, look, materials, true));
		const near = vertices(buildMachine(m, look, materials, false));
		expect(far).toBeLessThan(near / 3);
	});

	it("builds the same geometry twice for the same card — no jitter between mounts", () => {
		const m = machine({ seq: 7 });
		const look = machineLook(m, statusColor, materials);
		expect(buildMachine(m, look, materials, false).v).toEqual(
			buildMachine(m, look, materials, false).v,
		);
	});
});

describe("buildDistrict and buildSubstrate", () => {
	it("puts the event strata under the deck, never above it", () => {
		const target = { base: new MeshBuilder(), detail: new MeshBuilder(), ghost: new MeshBuilder() };
		buildDistrict(district({ center: [0, 0, 0] }), DARK_MATERIALS, target);
		// Every ghost vertex's y sits below the deck top (y ≈ +0.4).
		for (let i = 1; i < target.ghost.v.length; i += VERTEX_FLOATS) {
			expect(target.ghost.v[i]).toBeLessThan(0);
		}
	});

	it("scales the substrate with the scene rather than leaving a fixed square", () => {
		const small = buildSubstrate(DARK_MATERIALS, 40);
		const large = buildSubstrate(DARK_MATERIALS, 200);
		expect(vertices(large.base)).toBeGreaterThan(vertices(small.base));
	});
});

describe("buildRoutes", () => {
	const machines = new Map<string, StrataMachine>([
		["proj|1", machine({ seq: 1, key: "proj|1", pos: [0, 0, 0] })],
		["proj|2", machine({ seq: 2, key: "proj|2", pos: [20, 0, 0] })],
		["proj|3", machine({ seq: 3, key: "proj|3", pos: [40, 0, 0], unborn: true })],
	]);
	const always = () => true;

	it("draws nothing for a route whose endpoint the cursor says does not exist yet", () => {
		const { placed } = buildRoutes(
			[route({ from: "proj|1", to: "proj|3", key: "a" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		expect(placed).toHaveLength(0);
	});

	it("draws nothing for a route naming a card that is not on stage", () => {
		const { placed } = buildRoutes(
			[route({ from: "proj|1", to: "proj|missing", key: "a" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		expect(placed).toHaveLength(0);
	});

	it("gaps a failed route and marks it, so the verdict survives greyscale", () => {
		const delivered = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a", kind: "delivered" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		const failed = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a", kind: "failed" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		const held = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a", kind: "held" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		// Three kinds, three distinct vertex counts: the shape carries the verdict,
		// not only the colour.
		expect(
			new Set([
				vertices(delivered.mesh),
				vertices(failed.mesh),
				vertices(held.mesh),
			]).size,
		).toBe(3);
	});

	it("mutes a route the highlight predicate rejects without hiding it", () => {
		const lit = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a" })],
			machines,
			DARK_MATERIALS,
			() => true,
		);
		const dim = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a" })],
			machines,
			DARK_MATERIALS,
			() => false,
		);
		expect(dim.placed).toHaveLength(1);
		expect(vertices(dim.mesh)).toBe(vertices(lit.mesh));
		expect(dim.mesh.v).not.toEqual(lit.mesh.v);
	});

	it("lifts a coordinator's anchor higher than a worker's, so the beam clears the mast", () => {
		const withCoordinator = new Map(machines);
		withCoordinator.set("proj|1", machine({ seq: 1, key: "proj|1", pos: [0, 0, 0], role: "coordinator" }));
		const worker = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a" })],
			machines,
			DARK_MATERIALS,
			always,
		);
		const coordinator = buildRoutes(
			[route({ from: "proj|1", to: "proj|2", key: "a" })],
			withCoordinator,
			DARK_MATERIALS,
			always,
		);
		expect(coordinator.placed[0].points[0][1]).toBeGreaterThan(worker.placed[0].points[0][1]);
	});
});
