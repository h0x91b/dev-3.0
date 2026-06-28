import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

interface AnimatedNumberOptions {
	/** Tween duration in ms. Default 900. */
	durationMs?: number;
	/** Set false to disable animation (renders the target immediately). Default true. */
	enabled?: boolean;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Eases a displayed number toward `target` with an ease-out tween, starting from
 * 0 on first mount (so values "count up" / gauges sweep in) and from the current
 * displayed value on later changes (so range switches re-animate smoothly).
 *
 * Respects `prefers-reduced-motion` and environments without
 * `requestAnimationFrame` (tests): in those cases it returns `target` instantly.
 */
export function useAnimatedNumber(target: number, { durationMs = 900, enabled = true }: AnimatedNumberOptions = {}): number {
	const reduced = useReducedMotion();
	const animate = enabled && !reduced && typeof requestAnimationFrame === "function";
	const [value, setValue] = useState(() => (animate ? 0 : target));
	const valueRef = useRef(value);
	valueRef.current = value;

	useEffect(() => {
		if (!animate) {
			setValue(target);
			return;
		}
		const from = valueRef.current;
		const delta = target - from;
		if (delta === 0) return;

		let raf = 0;
		let startTs = 0;
		const tick = (ts: number) => {
			if (!startTs) startTs = ts;
			const t = Math.min(1, (ts - startTs) / durationMs);
			setValue(from + delta * easeOutCubic(t));
			if (t < 1) raf = requestAnimationFrame(tick);
			else setValue(target);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
		// valueRef is intentionally read at effect-start, not a dep.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target, durationMs, animate]);

	return animate ? value : target;
}
