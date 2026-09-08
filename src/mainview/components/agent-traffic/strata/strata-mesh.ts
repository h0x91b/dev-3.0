/**
 * The five primitives every Strata shape is built from.
 *
 * One interleaved vertex is `position(3) normal(3) colour(3) emissive(1)` — ten
 * floats, matching the stride `StrataGL.mesh` binds. Nothing here touches WebGL,
 * so the whole scene can be built and unit-tested without a canvas.
 */

import { rgb, V, type Vec3 } from "./strata-math";

/** Floats per vertex: position, normal, colour, emissive. */
export const VERTEX_FLOATS = 10;

export class MeshBuilder {
	readonly v: number[] = [];

	tri(a: Vec3, b: Vec3, c: Vec3, color: string | Vec3, emissive = 0, normal?: Vec3): void {
		const n = normal ?? V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
		const col = rgb(color);
		for (const p of [a, b, c]) this.v.push(...p, ...n, ...col, emissive);
	}

	quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: string | Vec3, emissive = 0, normal?: Vec3): void {
		this.tri(a, b, c, color, emissive, normal);
		this.tri(a, c, d, color, emissive, normal);
	}

	box(
		x: number, y: number, z: number,
		w: number, h: number, d: number,
		color: string | Vec3, emissive = 0, rot = 0,
	): void {
		const points = (
			[
				[-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, h, -d / 2], [-w / 2, h, -d / 2],
				[-w / 2, 0, d / 2], [w / 2, 0, d / 2], [w / 2, h, d / 2], [-w / 2, h, d / 2],
			] as Vec3[]
		).map(
			(p): Vec3 => [
				x + p[0] * Math.cos(rot) - p[2] * Math.sin(rot),
				y + p[1],
				z + p[0] * Math.sin(rot) + p[2] * Math.cos(rot),
			],
		);
		for (const face of [
			[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4],
		]) {
			this.quad(points[face[0]], points[face[1]], points[face[2]], points[face[3]], color, emissive);
		}
	}

	/** A cone/cylinder/hex prism: `segments` drives the silhouette, `r2` the top radius. */
	cyl(
		x: number, y: number, z: number,
		r: number, h: number,
		color: string | Vec3, segments = 32, r2 = r, emissive = 0, start = 0,
	): void {
		for (let i = 0; i < segments; i++) {
			const a = start + (i / segments) * Math.PI * 2;
			const b = start + ((i + 1) / segments) * Math.PI * 2;
			const p: Vec3 = [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
			const q: Vec3 = [x + Math.cos(b) * r, y, z + Math.sin(b) * r];
			const s: Vec3 = [x + Math.cos(a) * r2, y + h, z + Math.sin(a) * r2];
			const t: Vec3 = [x + Math.cos(b) * r2, y + h, z + Math.sin(b) * r2];
			this.quad(p, s, t, q, color, emissive, V.norm([
				Math.cos((a + b) / 2),
				(r - r2) / (h || 0.001),
				Math.sin((a + b) / 2),
			]));
			this.tri([x, y + h, z], t, s, color, emissive, [0, 1, 0]);
			this.tri([x, y, z], p, q, color, emissive, [0, -1, 0]);
		}
	}

	/** A ring, optionally a partial arc — the stage's status halos and deck rims. */
	torus(
		x: number, y: number, z: number,
		r: number, thickness: number,
		color: string | Vec3, emissive = 0,
		plane: "xz" | "xy" = "xz",
		arc = Math.PI * 2, start = 0,
	): void {
		const n = Math.max(12, Math.round((48 * arc) / (Math.PI * 2)));
		const m = 6;
		const point = (a: number, b: number): Vec3 => {
			let p: Vec3 = [
				(r + thickness * Math.cos(b)) * Math.cos(a),
				thickness * Math.sin(b),
				(r + thickness * Math.cos(b)) * Math.sin(a),
			];
			if (plane === "xy") p = [p[0], p[2], p[1]];
			return [x + p[0], y + p[1], z + p[2]];
		};
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < m; j++) {
				const a = start + (i / n) * arc;
				const b = start + ((i + 1) / n) * arc;
				const c = (j / m) * Math.PI * 2;
				const d = ((j + 1) / m) * Math.PI * 2;
				this.quad(point(a, c), point(b, c), point(b, d), point(a, d), color, emissive);
			}
		}
	}

	/** A square-section bar from `a` to `b` — every wire, rail and route segment. */
	beam(a: Vec3, b: Vec3, width: number, color: string | Vec3, emissive = 0): void {
		const d = V.norm(V.sub(b, a));
		let side = V.norm(V.cross(d, [0, 1, 0]));
		// A vertical beam has no meaningful "side" — the cross product degenerates.
		if (Math.hypot(side[0], side[1], side[2]) < 0.1) side = [1, 0, 0];
		side = V.mul(side, width / 2);
		const up = V.mul(V.norm(V.cross(d, side)), width / 2);
		const near: Vec3[] = [
			V.add(V.add(a, side), up),
			V.add(V.sub(a, side), up),
			V.sub(V.sub(a, side), up),
			V.sub(V.add(a, side), up),
		];
		const far = near.map((p) => V.add(p, V.sub(b, a)));
		for (let i = 0; i < 4; i++) {
			this.quad(near[i], near[(i + 1) % 4], far[(i + 1) % 4], far[i], color, emissive);
		}
	}
}
