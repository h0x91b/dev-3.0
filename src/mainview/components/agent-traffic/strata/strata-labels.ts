/**
 * Which floating labels the stage shows, and where.
 *
 * A 3D scene projects far more labels than a screen can hold, and showing them
 * all is how a beautiful stage becomes an unreadable one. So labels are ranked
 * by how much the user needs them, then placed greedily, and one that would
 * overlap an already-placed label or a reserved overlay panel is dropped
 * entirely rather than nudged — a nudged label points at the wrong machine.
 *
 * Pure geometry so the whole policy is unit-testable without a canvas: the
 * caller hands over projected screen points and gets back the survivors.
 */

import type { StrataMachine } from "./strata-model";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ProjectedPoint {
	x: number;
	y: number;
	visible: boolean;
}

export interface PlacedLabel {
	key: string;
	x: number;
	y: number;
	rect: Rect;
}

/**
 * Label priority. Higher wins a contested slot.
 *
 * The order is what the user came to find: the selected card first, then the
 * three states that are asking for something (undelivered, asking the user,
 * hibernated-but-in-traffic), then coordinators as landmarks, then the rest by
 * seq so the ordering is stable rather than arbitrary.
 */
export function labelRank(machine: StrataMachine, selected: string | null): number {
	let rank = machine.key === selected ? 10_000 : 0;
	if (machine.undelivered) rank += 1000;
	else if (machine.status === "user-questions") rank += 800;
	else if (machine.role === "coordinator") rank += 700;
	else if (machine.hibernated) rank += 120;
	else if (machine.status === "in-progress") rank += 200;
	// A busier card is a better landmark than a silent one.
	rank += Math.min(90, machine.messageCount * 6);
	// Stable tiebreak, never a coin flip.
	rank -= (machine.node.seq ?? 0) * 0.001;
	return rank;
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * How many labels a stage of this width may show at once.
 *
 * Measured against the reference, not guessed: below 520px the stage holds five
 * before they collide, and past 1200px more than twelve stops helping and starts
 * competing with the deck decals.
 */
export function labelBudget(width: number): number {
	if (width < 520) return 5;
	if (width < 800) return 8;
	if (width < 1200) return 10;
	return 12;
}

export function placeLabels(input: {
	machines: StrataMachine[];
	selected: string | null;
	/** Projected anchor per machine key, already lifted above the model. */
	points: Map<string, ProjectedPoint>;
	/** Measured label width per key; the caller knows its own fonts. */
	sizes: Map<string, { w: number; h: number }>;
	width: number;
	height: number;
	/** Overlay panels the labels must not hide. */
	reserved: Rect[];
}): PlacedLabel[] {
	const { machines, selected, points, sizes, width, height, reserved } = input;
	const budget = labelBudget(width);
	const occupied = [...reserved];
	const placed: PlacedLabel[] = [];
	const ranked = [...machines].sort(
		(a, b) => labelRank(b, selected) - labelRank(a, selected),
	);
	for (const machine of ranked) {
		if (machine.unborn) continue;
		const point = points.get(machine.key);
		if (!point?.visible) continue;
		const isSelected = machine.key === selected;
		if (placed.length >= budget && !isSelected) continue;
		const size = sizes.get(machine.key) ?? { w: 150, h: 30 };
		let x = point.x;
		const y = point.y;
		// The selected label is offset sideways so it never sits on its own model,
		// and it is clamped inside the stage rather than dropped: the user asked
		// for this one.
		if (isSelected) {
			x = Math.min(
				width - size.w / 2 - 12,
				Math.max(size.w / 2 + 12, x + (width < 520 ? 38 : 85)),
			);
		}
		const rect: Rect = { x: x - size.w / 2, y: y - size.h, w: size.w, h: size.h };
		if (!isSelected) {
			// Off-stage, or under an overlay, or on top of a better label — gone.
			if (rect.x < 5 || rect.x + rect.w > width - 5) continue;
			if (rect.y < 4 || rect.y + rect.h > height - 8) continue;
			if (occupied.some((box) => overlaps(rect, box))) continue;
		}
		occupied.push(rect);
		placed.push({ key: machine.key, x, y: y - 8, rect });
	}
	return placed;
}
