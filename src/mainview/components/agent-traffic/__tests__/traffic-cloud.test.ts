import { describe, expect, it } from "vitest";
import { cloudGeometry } from "../traffic-cloud";

/** Every circle in a `d`, as {cx, cy, r} — the arcs are written from the left point. */
function circles(d: string): { cx: number; cy: number; r: number }[] {
	return [...d.matchAll(/M(-?[\d.]+),(-?[\d.]+)A([\d.]+),[\d.]+ 0 0,1 (-?[\d.]+),/g)].map(match => {
		const left = Number(match[1]);
		const right = Number(match[4]);
		return { cx: (left + right) / 2, cy: Number(match[2]), r: Number(match[3]) };
	});
}

describe("cloudGeometry", () => {
	it("puts lobes on all four edges, so the silhouette is a cloud and not a pill", () => {
		const cloud = cloudGeometry(240, 80, { tail: true });
		const lobes = circles(cloud.body);
		const top = cloud.inset;
		const bottom = cloud.inset + 80;
		expect(lobes.some(lobe => lobe.cy === top)).toBe(true);
		expect(lobes.some(lobe => lobe.cy === bottom)).toBe(true);
		expect(lobes.some(lobe => lobe.cx === cloud.inset)).toBe(true);
		expect(lobes.some(lobe => lobe.cx === cloud.inset + 240)).toBe(true);
	});

	it("adds lobes as the text gets wider, so a long message does not get one fat lobe", () => {
		const narrow = circles(cloudGeometry(120, 60).body).filter(lobe => lobe.cy === cloudGeometry(120, 60).inset);
		const wide = circles(cloudGeometry(480, 60).body).filter(lobe => lobe.cy === cloudGeometry(480, 60).inset);
		expect(wide.length).toBeGreaterThan(narrow.length);
	});

	it("reserves room for the lobes around the content box", () => {
		const cloud = cloudGeometry(200, 70);
		expect(cloud.width).toBe(200 + cloud.inset * 2);
		expect(cloud.height).toBe(70 + cloud.inset * 2);
		expect(cloud.inset).toBeGreaterThan(0);
	});

	it("winds the rectangle and every lobe the same way, so a nonzero fill unions them", () => {
		// A reversed sweep flag anywhere would punch a hole in the middle of the cloud.
		const cloud = cloudGeometry(200, 70, { tail: true });
		for (const d of [cloud.body, cloud.bodyRim, cloud.tail, cloud.tailRim]) {
			expect(d).not.toContain("0,0");
			expect(d.startsWith("M")).toBe(true);
		}
	});

	it("grows the rim copy past the body, and only by a hair", () => {
		const cloud = cloudGeometry(200, 70);
		const body = circles(cloud.body);
		const rim = circles(cloud.bodyRim);
		expect(rim).toHaveLength(body.length);
		const grown = rim[0].r - body[0].r;
		expect(grown).toBeGreaterThan(0);
		expect(grown).toBeLessThan(3);
	});

	it("gives an anchored cloud a trail of shrinking puffs below the body", () => {
		const cloud = cloudGeometry(200, 70, { tail: true });
		const puffs = circles(cloud.tail);
		expect(puffs.length).toBeGreaterThanOrEqual(3);
		// Shrinking, and each one further down than the last.
		for (let index = 1; index < puffs.length; index += 1) {
			expect(puffs[index].r).toBeLessThan(puffs[index - 1].r);
			expect(puffs[index].cy).toBeGreaterThan(puffs[index - 1].cy);
		}
		expect(cloud.tailHeight).toBeGreaterThan(0);
	});

	it("grows no trail in flow, where there is no card below to point at", () => {
		const cloud = cloudGeometry(200, 70);
		expect(cloud.tail).toBe("");
		expect(cloud.tailRim).toBe("");
		expect(cloud.tailHeight).toBe(0);
	});

	it("stays a drawable cloud at a degenerate size instead of collapsing", () => {
		const cloud = cloudGeometry(0, 0, { tail: true });
		expect(cloud.width).toBeGreaterThan(0);
		expect(cloud.height).toBeGreaterThan(0);
		expect(circles(cloud.body).length).toBeGreaterThanOrEqual(3);
	});
});
