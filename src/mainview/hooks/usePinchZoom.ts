import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** Scale a double-tap / double-click zooms into. */
export const DOUBLE_TAP_SCALE = 2.5;

export interface ZoomTransform {
	scale: number;
	/** Translation in px, applied AFTER scaling around the element's centre. */
	x: number;
	y: number;
}

export const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

/**
 * Clamp a transform: scale into [MIN_SCALE, MAX_SCALE], and translation so the
 * scaled content never drifts past the element edges (transform-origin centre).
 * `rectW`/`rectH` are the on-screen size of the zoomable element.
 */
export function clampTransform(t: ZoomTransform, rectW: number, rectH: number): ZoomTransform {
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale));
	if (scale <= MIN_SCALE) return { scale, x: 0, y: 0 };
	const maxX = (rectW * (scale - 1)) / 2;
	const maxY = (rectH * (scale - 1)) / 2;
	return {
		scale,
		x: Math.min(maxX, Math.max(-maxX, t.x)),
		y: Math.min(maxY, Math.max(-maxY, t.y)),
	};
}

/**
 * Return a transform that scales to `targetScale` while keeping the content
 * point currently under (`px`, `py`) — coordinates relative to the element's
 * centre — anchored in place. Result is NOT clamped; clamp the output yourself.
 */
export function zoomAt(t: ZoomTransform, px: number, py: number, targetScale: number): ZoomTransform {
	const ratio = targetScale / t.scale;
	return {
		scale: targetScale,
		x: px - (px - t.x) * ratio,
		y: py - (py - t.y) * ratio,
	};
}

const TAP_MOVE_PX = 10;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

export interface PinchZoom {
	/** Ref callback — attach to the element that both captures gestures and is
	 * the reference box for centre/clamp math (usually the stage container). */
	setNode: (node: HTMLElement | null) => void;
	/** CSS transform for the zoomable content. */
	transform: string;
	/** True while zoomed in (scale > 1) — drives cursor / pan affordances. */
	zoomed: boolean;
	/** Reset to the neutral (unzoomed, centred) state. */
	reset: () => void;
	/** Whether transform changes should animate (off during an active gesture). */
	animated: boolean;
}

/**
 * Pinch-to-zoom + drag-to-pan + double-tap gesture handling via Pointer Events,
 * so it works identically for touch (mobile / remote browser) and mouse/trackpad
 * (desktop). Two pointers pinch-zoom around their midpoint; a single pointer pans
 * once zoomed; a double-tap toggles between fit and DOUBLE_TAP_SCALE; ctrl-wheel
 * (trackpad pinch) zooms toward the cursor. When `enabled` is false the hook is
 * inert and the transform stays at identity.
 */
export function usePinchZoom(enabled: boolean): PinchZoom {
	const [t, setT] = useState<ZoomTransform>(IDENTITY);
	const [animated, setAnimated] = useState(true);
	const [node, setNode] = useState<HTMLElement | null>(null);

	const tRef = useRef(t);
	tRef.current = t;
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;

	const reset = useCallback(() => {
		setAnimated(true);
		setT(IDENTITY);
	}, []);

	// Snap back to identity whenever gestures get disabled (e.g. leaving fit mode).
	useEffect(() => {
		if (!enabled) setT(IDENTITY);
	}, [enabled]);

	useEffect(() => {
		if (!node) return;

		const pointers = new Map<number, { x: number; y: number }>();
		let pinch: { dist: number; t: ZoomTransform; midX: number; midY: number } | null = null;
		let pan: { px: number; py: number; x: number; y: number } | null = null;
		let multiTouch = false;
		let tapStart: { x: number; y: number; time: number } | null = null;
		let lastTap: { x: number; y: number; time: number } | null = null;

		const centre = () => {
			const r = node.getBoundingClientRect();
			return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
		};
		const clamp = (next: ZoomTransform) => {
			const { w, h } = centre();
			return clampTransform(next, w, h);
		};

		const onDown = (e: PointerEvent) => {
			if (!enabledRef.current) return;
			node.setPointerCapture?.(e.pointerId);
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 2) {
				multiTouch = true;
				pan = null;
				const [a, b] = [...pointers.values()];
				pinch = {
					dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
					t: tRef.current,
					midX: (a.x + b.x) / 2,
					midY: (a.y + b.y) / 2,
				};
				setAnimated(false);
			} else if (pointers.size === 1) {
				tapStart = { x: e.clientX, y: e.clientY, time: performance.now() };
				if (tRef.current.scale > MIN_SCALE) {
					pan = { px: e.clientX, py: e.clientY, x: tRef.current.x, y: tRef.current.y };
					setAnimated(false);
				}
			}
		};

		const onMove = (e: PointerEvent) => {
			if (!pointers.has(e.pointerId)) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pinch && pointers.size >= 2) {
				e.preventDefault();
				const [a, b] = [...pointers.values()];
				const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
				const { cx, cy } = centre();
				const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (pinch.t.scale * dist) / pinch.dist));
				// Content point anchored under the original pinch midpoint.
				const anchorX = (pinch.midX - cx - pinch.t.x) / pinch.t.scale;
				const anchorY = (pinch.midY - cy - pinch.t.y) / pinch.t.scale;
				const midX = (a.x + b.x) / 2 - cx;
				const midY = (a.y + b.y) / 2 - cy;
				setT(clamp({ scale, x: midX - anchorX * scale, y: midY - anchorY * scale }));
			} else if (pan && pointers.size === 1) {
				e.preventDefault();
				setT(clamp({ scale: tRef.current.scale, x: pan.x + (e.clientX - pan.px), y: pan.y + (e.clientY - pan.py) }));
			}
		};

		const maybeDoubleTap = (e: PointerEvent) => {
			if (multiTouch || !tapStart) return;
			const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
			const dur = performance.now() - tapStart.time;
			if (moved > TAP_MOVE_PX || dur > TAP_MAX_MS) return;
			const now = performance.now();
			if (lastTap && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX) {
				lastTap = null;
				setAnimated(true);
				if (tRef.current.scale > MIN_SCALE) {
					setT(IDENTITY);
				} else {
					const { cx, cy } = centre();
					setT(clamp(zoomAt(tRef.current, e.clientX - cx, e.clientY - cy, DOUBLE_TAP_SCALE)));
				}
			} else {
				lastTap = { x: e.clientX, y: e.clientY, time: now };
			}
		};

		const onUp = (e: PointerEvent) => {
			pointers.delete(e.pointerId);
			node.releasePointerCapture?.(e.pointerId);
			if (pointers.size < 2) pinch = null;
			if (pointers.size === 1 && tRef.current.scale > MIN_SCALE) {
				// Hand the surviving finger a fresh pan anchor after a pinch ends.
				const [pt] = [...pointers.values()];
				pan = { px: pt.x, py: pt.y, x: tRef.current.x, y: tRef.current.y };
			}
			if (pointers.size === 0) {
				if (enabledRef.current) maybeDoubleTap(e);
				pan = null;
				tapStart = null;
				multiTouch = false;
				setAnimated(true);
			}
		};

		const onWheel = (e: WheelEvent) => {
			if (!enabledRef.current || !e.ctrlKey) return;
			e.preventDefault();
			const { cx, cy } = centre();
			const factor = Math.exp(-e.deltaY / 200);
			setAnimated(false);
			setT(clamp(zoomAt(tRef.current, e.clientX - cx, e.clientY - cy, tRef.current.scale * factor)));
		};

		node.addEventListener("pointerdown", onDown);
		node.addEventListener("pointermove", onMove, { passive: false });
		node.addEventListener("pointerup", onUp);
		node.addEventListener("pointercancel", onUp);
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			node.removeEventListener("pointerdown", onDown);
			node.removeEventListener("pointermove", onMove);
			node.removeEventListener("pointerup", onUp);
			node.removeEventListener("pointercancel", onUp);
			node.removeEventListener("wheel", onWheel);
		};
	}, [node]);

	return {
		setNode,
		transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
		zoomed: t.scale > MIN_SCALE,
		reset,
		animated,
	};
}
