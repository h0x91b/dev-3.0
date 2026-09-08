/**
 * The orbit camera: where it is, where it is going, and how a pointer moves it.
 *
 * Two copies of every value — `yaw` and `toYaw` — with the live one chasing the
 * target each frame. That is what makes a click-to-frame glide instead of a cut,
 * and it means an input handler only ever writes a target and never fights the
 * render loop.
 *
 * A mutable object rather than React state on purpose: the loop reads it 60
 * times a second, and routing that through `setState` would re-render the whole
 * stage per frame.
 */

import { V, type Vec3 } from "./strata-math";

export interface StrataCamera {
	yaw: number;
	pitch: number;
	distance: number;
	target: Vec3;
	toYaw: number;
	toPitch: number;
	toDistance: number;
	toTarget: Vec3;
}

/** Pitch floor and ceiling: never under the deck, never straight down. */
export const PITCH_MIN = 0.22;
export const PITCH_MAX = 1.43;
export const DISTANCE_MIN = 22;
export const DISTANCE_MAX = 350;

export function createCamera(extent: number): StrataCamera {
	const distance = framingDistance(extent);
	return {
		yaw: 0.49,
		pitch: 0.76,
		distance,
		target: [0, 0, 0],
		toYaw: 0.49,
		toPitch: 0.76,
		toDistance: distance,
		toTarget: [0, 0, 0],
	};
}

/**
 * How far back the whole scene fits.
 *
 * Scales with the scene, not with the viewport: a board with twelve projects has
 * a wider ring than one with two, and a fixed distance would either clip the big
 * one or strand the small one in empty space.
 */
export function framingDistance(extent: number): number {
	return Math.max(DISTANCE_MIN, Math.min(DISTANCE_MAX, 34 + extent * 1.55));
}

export function home(camera: StrataCamera, extent: number): void {
	camera.toTarget = [0, 0, 0];
	camera.toYaw = 0.49;
	camera.toPitch = 0.76;
	camera.toDistance = framingDistance(extent);
}

/** Fly to one point — a selected card, or the midpoint of an exchange. */
export function frame(camera: StrataCamera, at: Vec3, distance = 34): void {
	camera.toTarget = [at[0], at[1] + 1.4, at[2]];
	camera.toDistance = Math.max(DISTANCE_MIN, Math.min(DISTANCE_MAX, distance));
	camera.toPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, 0.62));
}

export function zoomBy(camera: StrataCamera, factor: number): void {
	camera.toDistance = Math.max(
		DISTANCE_MIN,
		Math.min(DISTANCE_MAX, camera.toDistance * factor),
	);
}

/** Screen-space drag → world-space target move, in the camera's own basis. */
export function pan(camera: StrataCamera, dx: number, dy: number): void {
	const k = camera.toDistance * 0.0015;
	const sy = Math.sin(camera.toYaw);
	const cy = Math.cos(camera.toYaw);
	camera.toTarget = [
		Math.max(-150, Math.min(150, camera.toTarget[0] + (-dx * cy - dy * sy) * k)),
		camera.toTarget[1],
		Math.max(-150, Math.min(150, camera.toTarget[2] + (dx * sy - dy * cy) * k)),
	];
}

export function orbit(camera: StrataCamera, dx: number, dy: number): void {
	camera.toYaw -= dx * 0.006;
	camera.toPitch = Math.max(
		PITCH_MIN,
		Math.min(PITCH_MAX, camera.toPitch + dy * 0.005),
	);
}

/**
 * Advance the live values toward their targets and return the eye position.
 *
 * `reduced` snaps instead of easing: with `prefers-reduced-motion` a framing
 * still has to happen — the user asked to look at something — but it arrives
 * without the flight.
 */
export function advance(
	camera: StrataCamera,
	dt: number,
	reduced: boolean,
): Vec3 {
	const lerp = reduced ? 1 : 1 - Math.exp(-dt * 8);
	camera.yaw += (camera.toYaw - camera.yaw) * lerp;
	camera.pitch += (camera.toPitch - camera.pitch) * lerp;
	camera.distance += (camera.toDistance - camera.distance) * lerp;
	camera.target = [
		camera.target[0] + (camera.toTarget[0] - camera.target[0]) * lerp,
		camera.target[1] + (camera.toTarget[1] - camera.target[1]) * lerp,
		camera.target[2] + (camera.toTarget[2] - camera.target[2]) * lerp,
	];
	const cp = Math.cos(camera.pitch);
	return [
		camera.target[0] + Math.sin(camera.yaw) * cp * camera.distance,
		camera.target[1] + Math.sin(camera.pitch) * camera.distance,
		camera.target[2] + Math.cos(camera.yaw) * cp * camera.distance,
	];
}

/** True once the camera has effectively arrived — used to stop redundant frames. */
export function settled(camera: StrataCamera): boolean {
	return (
		Math.abs(camera.toYaw - camera.yaw) < 0.0004 &&
		Math.abs(camera.toPitch - camera.pitch) < 0.0004 &&
		Math.abs(camera.toDistance - camera.distance) < 0.02 &&
		Math.hypot(...V.sub(camera.toTarget, camera.target)) < 0.02
	);
}

export interface PointerBindingHost {
	camera: StrataCamera;
	/** A tap that did not drag: hit-test at these canvas-local coordinates. */
	onTap: (x: number, y: number) => void;
	/** Double click / double tap. */
	onFrame: () => void;
	/** Any manual camera move — the stage stops following replay when this fires. */
	onManual: () => void;
}

/**
 * Pointer, wheel and pinch handling on the canvas.
 *
 * One `pointer*` family covers mouse, trackpad and touch, so there is no
 * separate touch path to keep in sync. Returns its own teardown: the stage
 * switch unmounts this presentation, and a listener surviving that would keep
 * driving a disposed camera.
 */
export function bindPointer(
	canvas: HTMLCanvasElement,
	host: PointerBindingHost,
): () => void {
	const pointers = new Map<number, { x: number; y: number }>();
	let moved = 0;
	let pinch: { distance: number; center: [number, number] } | null = null;
	const midpoint = (): [number, number] => {
		const all = [...pointers.values()];
		return [(all[0].x + all[1].x) / 2, (all[0].y + all[1].y) / 2];
	};

	const onContextMenu = (event: Event) => event.preventDefault();
	const onDown = (event: PointerEvent) => {
		canvas.setPointerCapture(event.pointerId);
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		moved = 0;
		if (pointers.size === 2) {
			const all = [...pointers.values()];
			pinch = {
				distance: Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y),
				center: midpoint(),
			};
		}
	};
	const onMove = (event: PointerEvent) => {
		const previous = pointers.get(event.pointerId);
		if (!previous) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		const dx = event.clientX - previous.x;
		const dy = event.clientY - previous.y;
		moved += Math.hypot(dx, dy);
		if (pointers.size === 2) {
			const all = [...pointers.values()];
			const distance = Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y);
			const center = midpoint();
			if (pinch) {
				zoomBy(host.camera, pinch.distance / (distance || 1));
				pan(host.camera, center[0] - pinch.center[0], center[1] - pinch.center[1]);
				host.onManual();
			}
			pinch = { distance, center };
			return;
		}
		// Shift-drag and right-drag pan; a plain drag orbits. Same grammar as
		// every 3D viewport the user has met before.
		if (event.shiftKey || event.buttons === 2) pan(host.camera, dx, dy);
		else orbit(host.camera, dx, dy);
		host.onManual();
	};
	const onUp = (event: PointerEvent) => {
		pointers.delete(event.pointerId);
		pinch = null;
		// Under 5px of travel is a click, not a drag — the same threshold the
		// stage's own minimap uses, so a shaky tap still selects.
		if (moved < 5 && event.button === 0 && !pointers.size) {
			const rect = canvas.getBoundingClientRect();
			host.onTap(event.clientX - rect.left, event.clientY - rect.top);
		}
	};
	const onCancel = (event: PointerEvent) => {
		pointers.delete(event.pointerId);
		pinch = null;
	};
	const onWheel = (event: WheelEvent) => {
		event.preventDefault();
		zoomBy(host.camera, Math.exp(event.deltaY * 0.001));
		host.onManual();
	};
	const onDoubleClick = () => host.onFrame();

	canvas.addEventListener("contextmenu", onContextMenu);
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onCancel);
	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("dblclick", onDoubleClick);
	return () => {
		canvas.removeEventListener("contextmenu", onContextMenu);
		canvas.removeEventListener("pointerdown", onDown);
		canvas.removeEventListener("pointermove", onMove);
		canvas.removeEventListener("pointerup", onUp);
		canvas.removeEventListener("pointercancel", onCancel);
		canvas.removeEventListener("wheel", onWheel);
		canvas.removeEventListener("dblclick", onDoubleClick);
	};
}
