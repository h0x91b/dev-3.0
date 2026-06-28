import { useAnimatedNumber } from "../../utils/useAnimatedNumber";

interface CountUpProps {
	/** Target value to count up to. */
	value: number;
	/** Format the (possibly fractional, mid-tween) number for display. */
	format: (n: number) => string;
	/** Tween duration in ms. */
	durationMs?: number;
}

/**
 * Renders a number that counts up to `value` on mount (and re-animates when the
 * value changes). Respects reduced-motion — see {@link useAnimatedNumber}.
 */
export function CountUp({ value, format, durationMs }: CountUpProps) {
	const v = useAnimatedNumber(value, { durationMs });
	return <>{format(v)}</>;
}

export default CountUp;
