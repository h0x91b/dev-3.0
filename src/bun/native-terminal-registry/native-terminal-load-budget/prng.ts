/**
 * Deterministic PRNG for the native-terminal load/budget harness.
 *
 * The harness must be byte-for-byte reproducible run to run, so it never touches
 * Math.random. mulberry32 is a tiny, well-distributed 32-bit generator: same
 * seed → same stream of bytes and frame shapes → same measured budgets.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Uniform integer in [min, max]. */
export function randomInt(rng: Rng, min: number, max: number): number {
	return min + Math.floor(rng() * (max - min + 1));
}
