/**
 * Vector and 4×4 matrix helpers for the Strata stage.
 *
 * Hand-written rather than a dependency: the stage needs eight operations, and a
 * matrix library would be the only 3D package in the tree. Column-major, the
 * layout `gl.uniformMatrix4fv` expects with `transpose = false`, so a matrix goes
 * to the GPU untouched.
 */

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export const V = {
	add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
	sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
	mul: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
	dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
	cross: (a: Vec3, b: Vec3): Vec3 => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	],
	norm: (a: Vec3): Vec3 => {
		const length = Math.hypot(a[0], a[1], a[2]) || 1;
		return [a[0] / length, a[1] / length, a[2] / length];
	},
};

export const M = {
	mul(a: Float32Array, b: Float32Array): Float32Array {
		const out = new Float32Array(16);
		for (let column = 0; column < 4; column++)
			for (let row = 0; row < 4; row++)
				for (let k = 0; k < 4; k++)
					out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
		return out;
	},
	persp(fov: number, aspect: number, near: number, far: number): Float32Array {
		const q = 1 / Math.tan(fov / 2);
		return new Float32Array([
			q / aspect, 0, 0, 0,
			0, q, 0, 0,
			0, 0, (far + near) / (near - far), -1,
			0, 0, (2 * far * near) / (near - far), 0,
		]);
	},
	look(eye: Vec3, center: Vec3): Float32Array {
		const z = V.norm(V.sub(eye, center));
		const x = V.norm(V.cross([0, 1, 0], z));
		const y = V.cross(z, x);
		return new Float32Array([
			x[0], y[0], z[0], 0,
			x[1], y[1], z[1], 0,
			x[2], y[2], z[2], 0,
			-V.dot(x, eye), -V.dot(y, eye), -V.dot(z, eye), 1,
		]);
	},
	apply(m: Float32Array, p: Vec3): Vec4 {
		return [0, 1, 2, 3].map(
			(row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row],
		) as Vec4;
	},
};

/** `#rrggbb` (or an already-decoded triple) to normalised linear-ish RGB. */
export function rgb(color: string | Vec3): Vec3 {
	if (Array.isArray(color)) return color;
	const hex = color.replace("#", "");
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Vec3;
}

/**
 * Deterministic pseudo-random in `[0, 1)` from one integer.
 *
 * Seeded, not `Math.random`: the substrate's scattered plates and a card's
 * jitter must be identical on every mount, or the stage reshuffles itself each
 * time the user switches presentation.
 */
export function noise(n: number): number {
	const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}
