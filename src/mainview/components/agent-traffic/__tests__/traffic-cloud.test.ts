import { describe, expect, it } from "vitest";
import { COMPACT_LOBE_R, cloudGeometry } from "../traffic-cloud";

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
		// Lobes straddle an edge rather than sitting exactly on it — they are lifted
		// and sagged to undulate — so assert the overhang, not the coordinate.
		expect(lobes.some(lobe => lobe.cy <= top && lobe.cy - lobe.r < top)).toBe(true);
		expect(lobes.some(lobe => lobe.cy >= bottom && lobe.cy + lobe.r > bottom)).toBe(true);
		expect(lobes.some(lobe => lobe.cx === cloud.inset)).toBe(true);
		expect(lobes.some(lobe => lobe.cx === cloud.inset + 240)).toBe(true);
	});

	it("covers the content box's corners, so the cloud grows no square shoulders", () => {
		// The bug this guards: lobe centres sit on the EDGES, so without a lobe of its
		// own every corner of the rectangle pokes out past its neighbours and the
		// silhouette reads as a dented rectangle instead of a cloud.
		const [width, height] = [240, 80];
		const cloud = cloudGeometry(width, height);
		const lobes = circles(cloud.body);
		for (const [cx, cy] of [
			[cloud.inset, cloud.inset],
			[cloud.inset + width, cloud.inset],
			[cloud.inset, cloud.inset + height],
			[cloud.inset + width, cloud.inset + height],
		]) {
			const covered = lobes.some(lobe => Math.hypot(lobe.cx - cx, lobe.cy - cy) < lobe.r);
			expect(covered).toBe(true);
		}
	});

	it("varies the lobe radii, because uniform scallops read as machined, not as a cloud", () => {
		const radii = new Set(circles(cloudGeometry(320, 80).body).map(lobe => lobe.r));
		expect(radii.size).toBeGreaterThanOrEqual(4);
	});

	it("adds lobes as the text gets wider, so a long message does not get one fat lobe", () => {
		const above = (contentWidth: number) => {
			const cloud = cloudGeometry(contentWidth, 60);
			return circles(cloud.body).filter(lobe => lobe.cy < cloud.inset).length;
		};
		expect(above(480)).toBeGreaterThan(above(120));
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

	it("fits between two rows of cards at the compact lobe, where the full size does not", () => {
		// The two shapes as they actually render: four lines of text at full size,
		// one clipped line as a preview. The gap between two card rows on the stage
		// is what this has to fit into — measured there at ~130px.
		const full = cloudGeometry(250, 78, { tail: true });
		const preview = cloudGeometry(210, 18, { tail: true, lobe: COMPACT_LOBE_R });
		expect(full.height).toBeGreaterThan(130);
		expect(preview.height).toBeLessThan(130);
		// Still a cloud, not a pill: the lobes shrank, they did not disappear.
		expect(circles(preview.body).length).toBeGreaterThanOrEqual(5);
		const radii = new Set(circles(preview.body).map(lobe => lobe.r));
		expect(radii.size).toBeGreaterThanOrEqual(4);
		// And its trail shrank with it instead of trailing a full-size tail.
		expect(preview.tailHeight).toBeLessThan(full.tailHeight);
	});
});
