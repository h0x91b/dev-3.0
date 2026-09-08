import { describe, expect, it, vi } from "vitest";
import {
	advance,
	bindPointer,
	createCamera,
	DISTANCE_MAX,
	DISTANCE_MIN,
	FOV,
	frame,
	framingDistance,
	home,
	orbit,
	pan,
	PITCH_MAX,
	PITCH_MIN,
	settled,
	zoomBy,
} from "../strata-camera";

const bounds = (radius: number, center: [number, number, number] = [0, 0, 0]) => ({
	center: [center[0], center[1], center[2]] as [number, number, number],
	radius,
});

/**
 * Does a scene of this radius actually fit at this distance?
 *
 * The check the framing formula exists to satisfy, written independently of it:
 * project the scene's half-extents into the frustum's half-extents at that
 * distance, on both axes.
 */
function fits(radius: number, distance: number, aspect: number, pitch = 0.76): boolean {
	const halfHeight = distance * Math.tan(FOV / 2);
	const halfWidth = halfHeight * aspect;
	return radius * Math.sin(pitch) <= halfHeight && radius <= halfWidth;
}

describe("framingDistance", () => {
	it("actually fits the scene, on a wide stage and on a tall one", () => {
		for (const aspect of [3.2, 16 / 9, 1, 0.5]) {
			for (const radius of [20, 50, 120]) {
				const distance = framingDistance(radius, aspect);
				expect(
					fits(radius, distance, aspect),
					`radius ${radius} at aspect ${aspect} did not fit at ${distance}`,
				).toBe(true);
			}
		}
	});

	it("needs to pull back further on a narrow stage than a wide one", () => {
		expect(framingDistance(50, 0.6)).toBeGreaterThan(framingDistance(50, 3.2));
	});

	it("scales with the scene rather than being a fixed number", () => {
		expect(framingDistance(100)).toBeGreaterThan(framingDistance(30));
	});

	it("stays inside the zoom limits even for an absurd scene", () => {
		expect(framingDistance(0.01)).toBeGreaterThanOrEqual(DISTANCE_MIN);
		expect(framingDistance(100_000)).toBeLessThanOrEqual(DISTANCE_MAX);
	});
});

describe("home", () => {
	it("aims at the scene's own centre, not the world origin", () => {
		const camera = createCamera(bounds(40));
		home(camera, bounds(40, [30, 0, -20]), 2);
		expect(camera.toTarget).toEqual([30, 0, -20]);
	});

	it("re-fits the distance for the aspect it is given", () => {
		const camera = createCamera(bounds(40));
		home(camera, bounds(40), 3.2);
		const wide = camera.toDistance;
		home(camera, bounds(40), 0.6);
		expect(camera.toDistance).toBeGreaterThan(wide);
	});
});

describe("zoom and orbit limits", () => {
	it("never zooms past either limit, however hard it is pushed", () => {
		const camera = createCamera(bounds(40));
		for (let i = 0; i < 200; i++) zoomBy(camera, 0.5);
		expect(camera.toDistance).toBe(DISTANCE_MIN);
		for (let i = 0; i < 200; i++) zoomBy(camera, 2);
		expect(camera.toDistance).toBe(DISTANCE_MAX);
	});

	it("never tips under the deck or straight down", () => {
		const camera = createCamera(bounds(40));
		for (let i = 0; i < 500; i++) orbit(camera, 0, -50);
		expect(camera.toPitch).toBe(PITCH_MIN);
		for (let i = 0; i < 500; i++) orbit(camera, 0, 50);
		expect(camera.toPitch).toBe(PITCH_MAX);
	});

	it("keeps yaw free — a scene has no back", () => {
		const camera = createCamera(bounds(40));
		const before = camera.toYaw;
		orbit(camera, 1000, 0);
		expect(camera.toYaw).not.toBe(before);
	});

	it("clamps a pan so the camera cannot be lost in empty grid", () => {
		const camera = createCamera(bounds(40));
		for (let i = 0; i < 400; i++) pan(camera, 500, 500);
		expect(Math.abs(camera.toTarget[0])).toBeLessThanOrEqual(150);
		expect(Math.abs(camera.toTarget[2])).toBeLessThanOrEqual(150);
	});
});

describe("frame", () => {
	it("centres on the point it is given, slightly above the deck", () => {
		const camera = createCamera(bounds(40));
		frame(camera, [10, 0, -5]);
		expect(camera.toTarget[0]).toBe(10);
		expect(camera.toTarget[2]).toBe(-5);
		expect(camera.toTarget[1]).toBeGreaterThan(0);
	});

	it("respects the zoom limits like every other move", () => {
		const camera = createCamera(bounds(40));
		frame(camera, [0, 0, 0], 1);
		expect(camera.toDistance).toBe(DISTANCE_MIN);
	});
});

describe("advance", () => {
	it("eases toward the target over several frames", () => {
		const camera = createCamera(bounds(40));
		camera.toDistance = 200;
		advance(camera, 1 / 60, false);
		expect(camera.distance).toBeGreaterThan(0);
		expect(camera.distance).toBeLessThan(200);
	});

	it("arrives in one frame under reduced motion — a framing must still happen", () => {
		const camera = createCamera(bounds(40));
		camera.toDistance = 200;
		camera.toTarget = [10, 0, 10];
		advance(camera, 1 / 60, true);
		expect(camera.distance).toBeCloseTo(200);
		expect(camera.target[0]).toBeCloseTo(10);
		expect(settled(camera)).toBe(true);
	});

	it("returns an eye position at the requested distance from the target", () => {
		const camera = createCamera(bounds(40));
		const eye = advance(camera, 1, true);
		expect(Math.hypot(eye[0] - camera.target[0], eye[1] - camera.target[1], eye[2] - camera.target[2])).toBeCloseTo(
			camera.distance,
		);
	});

	it("reports unsettled while it is still travelling", () => {
		const camera = createCamera(bounds(40));
		camera.toDistance = camera.distance + 50;
		expect(settled(camera)).toBe(false);
	});
});

describe("bindPointer", () => {
	function stubCanvas() {
		const listeners = new Map<string, Set<EventListener>>();
		const canvas = {
			addEventListener: vi.fn((type: string, handler: EventListener) => {
				listeners.set(type, (listeners.get(type) ?? new Set()).add(handler));
			}),
			removeEventListener: vi.fn((type: string, handler: EventListener) => {
				listeners.get(type)?.delete(handler);
			}),
			setPointerCapture: vi.fn(),
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
		} as unknown as HTMLCanvasElement;
		const fire = (type: string, event: Record<string, unknown>) => {
			for (const handler of listeners.get(type) ?? []) {
				handler({ preventDefault: () => {}, ...event } as unknown as Event);
			}
		};
		const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
		return { canvas, fire, count };
	}

	it("removes every listener it added, so an unmounted stage stops driving", () => {
		const { canvas, count } = stubCanvas();
		const camera = createCamera(bounds(40));
		const teardown = bindPointer(canvas, {
			camera,
			onTap: () => {},
			onFrame: () => {},
			onManual: () => {},
		});
		expect(count()).toBeGreaterThan(0);
		teardown();
		expect(count()).toBe(0);
	});

	it("treats a short press as a tap and a dragged one as an orbit", () => {
		const { canvas, fire } = stubCanvas();
		const camera = createCamera(bounds(40));
		const onTap = vi.fn();
		const onManual = vi.fn();
		bindPointer(canvas, { camera, onTap, onFrame: () => {}, onManual });

		fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
		fire("pointerup", { pointerId: 1, clientX: 101, clientY: 100, button: 0 });
		expect(onTap).toHaveBeenCalledWith(101, 100);

		const yaw = camera.toYaw;
		fire("pointerdown", { pointerId: 2, clientX: 100, clientY: 100, button: 0 });
		fire("pointermove", { pointerId: 2, clientX: 180, clientY: 100, buttons: 1 });
		fire("pointerup", { pointerId: 2, clientX: 180, clientY: 100, button: 0 });
		expect(camera.toYaw).not.toBe(yaw);
		expect(onManual).toHaveBeenCalled();
		// A drag is not also a selection.
		expect(onTap).toHaveBeenCalledTimes(1);
	});

	it("pans on a shift-drag instead of orbiting", () => {
		const { canvas, fire } = stubCanvas();
		const camera = createCamera(bounds(40));
		bindPointer(canvas, { camera, onTap: () => {}, onFrame: () => {}, onManual: () => {} });
		const yaw = camera.toYaw;
		const target = [...camera.toTarget];
		fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
		fire("pointermove", { pointerId: 1, clientX: 160, clientY: 130, buttons: 1, shiftKey: true });
		expect(camera.toYaw).toBe(yaw);
		expect(camera.toTarget).not.toEqual(target);
	});

	it("zooms on a wheel and reports it as a manual move", () => {
		const { canvas, fire } = stubCanvas();
		const camera = createCamera(bounds(40));
		const onManual = vi.fn();
		bindPointer(canvas, { camera, onTap: () => {}, onFrame: () => {}, onManual });
		const distance = camera.toDistance;
		fire("wheel", { deltaY: 240 });
		expect(camera.toDistance).toBeGreaterThan(distance);
		expect(onManual).toHaveBeenCalled();
	});
});
