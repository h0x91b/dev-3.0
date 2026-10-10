/**
 * pane-split-plan (seq 2124) — where a `dev3 pane run` pane goes.
 *
 * What must hold: the first pane halves the main pane to the right; every later
 * pane splits auxiliary space only, so the main pane keeps its size however many
 * runs open; the orientation follows usability rather than "always right"; ties
 * resolve the same way every time; and a layout with no room says so instead of
 * opening a strip.
 */
import { describe, it, expect } from "vitest";
import {
	describeNoRoom,
	paneUsability,
	planPaneSplit,
	splitCells,
	PANE_SPLIT_MIN_COLS,
	PANE_SPLIT_MIN_ROWS,
	type PaneSplitCandidate,
	type PaneSplitRequest,
} from "../../shared/pane-split-plan";
import type { SplitOrientation } from "../../shared/split-tree";

const BOTH: SplitOrientation[] = ["horizontal", "vertical"];

function request(main: PaneSplitCandidate, auxiliary: PaneSplitCandidate[], orientations = BOTH): PaneSplitRequest {
	return { main, auxiliary, orientations, separator: 1 };
}

/** Open `count` panes one after another, applying each plan the way tmux would. */
function openPanes(cols: number, rows: number, count: number, orientations = BOTH) {
	let main: PaneSplitCandidate = { paneId: "main", cols, rows, order: 0 };
	const aux: PaneSplitCandidate[] = [];
	const plans = [];
	for (let n = 1; n <= count; n++) {
		const plan = planPaneSplit(request(main, aux, orientations));
		plans.push(plan);
		if (plan.kind !== "split") break;
		if (plan.splitsMain) main = { ...main, ...plan.kept };
		else Object.assign(aux.find((pane) => pane.paneId === plan.paneId)!, plan.kept);
		aux.push({ paneId: `r${n}`, ...plan.added, order: n });
	}
	return { main, aux, plans };
}

describe("splitCells", () => {
	it("matches tmux's own -l 50% arithmetic, divider included", () => {
		// Measured on tmux 3.6a: 300 cols → 149 | 150, 80 rows → 39 | 40.
		expect(splitCells({ cols: 300, rows: 80 }, "horizontal", 1)).toEqual({
			kept: { cols: 149, rows: 80 },
			added: { cols: 150, rows: 80 },
		});
		expect(splitCells({ cols: 150, rows: 80 }, "vertical", 1)).toEqual({
			kept: { cols: 150, rows: 39 },
			added: { cols: 150, rows: 40 },
		});
		expect(splitCells({ cols: 101, rows: 10 }, "horizontal", 0).kept.cols).toBe(51);
	});
});

describe("paneUsability", () => {
	it("counts 80 columns and 24 rows as the same amount of terminal", () => {
		expect(paneUsability({ cols: 80, rows: 1000 })).toBe(paneUsability({ cols: 1000, rows: 24 }));
	});
});

describe("planPaneSplit", () => {
	it("gives the first pane the right half of the main pane", () => {
		const plan = planPaneSplit(request({ paneId: "%0", cols: 200, rows: 50, order: 0 }, []));
		expect(plan).toMatchObject({ kind: "split", splitsMain: true, paneId: "%0", orientation: "horizontal" });
	});

	it("puts the first pane below the main pane only when the right half would be a strip", () => {
		const plan = planPaneSplit(request({ paneId: "%0", cols: 70, rows: 60, order: 0 }, []));
		expect(plan).toMatchObject({ kind: "split", splitsMain: true, orientation: "vertical" });
	});

	it("never changes the main pane after the first split, however many panes open", () => {
		for (const [cols, rows] of [[300, 80], [200, 50], [100, 90]] as const) {
			const { main, plans } = openPanes(cols, rows, 6);
			expect(plans.filter((plan) => plan.kind === "split" && plan.splitsMain)).toHaveLength(1);
			expect(main.cols).toBe(cols - Math.floor(cols / 2) - 1);
			expect(main.rows).toBe(rows);
		}
	});

	it("stacks the second pane under the first in a wide window instead of halving its width", () => {
		const { aux } = openPanes(300, 80, 2);
		expect(aux.map(({ cols, rows }) => `${cols}x${rows}`)).toEqual(["150x39", "150x40"]);
	});

	it("tiles the auxiliary half into a grid, not a row of ever-narrower strips", () => {
		const { aux } = openPanes(300, 80, 4);
		expect(aux.every((pane) => pane.cols >= 74 && pane.rows >= 39)).toBe(true);
	});

	it("keeps stacking in a tall window, where a side-by-side split would be too narrow", () => {
		const { plans } = openPanes(100, 90, 4);
		expect(plans.slice(1).every((plan) => plan.kind === "split" && plan.orientation === "vertical")).toBe(true);
	});

	it("refuses rather than open a pane below the minimum, and never offers the main pane", () => {
		const { plans, main } = openPanes(100, 30, 3);
		const last = plans[2];
		expect(last.kind).toBe("no-room");
		expect(main.cols).toBe(49);
		if (last.kind === "no-room") {
			expect(last.closest?.paneId).not.toBe("main");
			expect(describeNoRoom(last)).toMatch(`below the ${PANE_SPLIT_MIN_COLS}x${PANE_SPLIT_MIN_ROWS} minimum`);
		}
	});

	it("refuses a first split that would leave the main pane itself unusable", () => {
		const plan = planPaneSplit(request({ paneId: "%0", cols: 60, rows: 12, order: 0 }, []));
		expect(plan.kind).toBe("no-room");
	});

	it("honours --below by never splitting side by side", () => {
		const { plans } = openPanes(300, 80, 3, ["vertical"]);
		expect(plans.every((plan) => plan.kind === "split" && plan.orientation === "vertical")).toBe(true);
	});

	it("halves the biggest pane even when a smaller one has the nicer shape", () => {
		const main = { paneId: "main", cols: 100, rows: 50, order: 0 };
		const flat = { paneId: "flat", cols: 240, rows: 10, order: 1 };
		const roomy = { paneId: "roomy", cols: 70, rows: 30, order: 2 };
		// 240x10 (2400 cells) beats 70x30 (2100) — split side by side, the only way that fits.
		expect(planPaneSplit(request(main, [roomy, flat]))).toMatchObject({ paneId: "flat", orientation: "horizontal" });
	});

	it("moves on to the next biggest pane when the biggest cannot be halved into two usable panes", () => {
		const main = { paneId: "main", cols: 100, rows: 50, order: 0 };
		const strip = { paneId: "strip", cols: 300, rows: 9, order: 1 };
		const ok = { paneId: "ok", cols: 90, rows: 20, order: 2 };
		expect(planPaneSplit(request(main, [strip, ok]))).toMatchObject({ paneId: "strip", orientation: "horizontal" });
		const tooThin = { paneId: "thin", cols: 79, rows: 30, order: 3 };
		const fine = { paneId: "fine", cols: 82, rows: 20, order: 4 };
		// 79x30 halves into 39 cols or 14|15 rows — rows fit, so it is still the one split.
		expect(planPaneSplit(request(main, [tooThin, fine]))).toMatchObject({ paneId: "thin", orientation: "vertical" });
		const dead = { paneId: "dead", cols: 79, rows: 15, order: 5 };
		expect(planPaneSplit(request(main, [dead, { paneId: "next", cols: 82, rows: 14, order: 6 }]))).toMatchObject({ paneId: "next" });
	});

	it("breaks a tie by the bigger pane, then right before below, then the older pane", () => {
		const main = { paneId: "main", cols: 100, rows: 50, order: 0 };
		// Same size, same score: the older one wins, whatever order they are listed in.
		const twins = [
			{ paneId: "new", cols: 100, rows: 24, order: 5 },
			{ paneId: "old", cols: 100, rows: 24, order: 2 },
		];
		expect(planPaneSplit(request(main, twins))).toMatchObject({ paneId: "old" });
		expect(planPaneSplit(request(main, [...twins].reverse()))).toMatchObject({ paneId: "old" });
		// 161x49 halves into 80x49 side by side or 161x24 stacked — both score 1920: right wins.
		const even = planPaneSplit(request(main, [{ paneId: "a", cols: 161, rows: 49, order: 1 }]));
		expect(even).toMatchObject({ paneId: "a", orientation: "horizontal", score: 1920 });
	});

	it("does not depend on which pane is focused — focus is not an input at all", () => {
		const main = { paneId: "main", cols: 149, rows: 80, order: 0 };
		const aux = [
			{ paneId: "r1", cols: 150, rows: 39, order: 1 },
			{ paneId: "r2", cols: 150, rows: 40, order: 2 },
		];
		expect(planPaneSplit(request(main, aux))).toEqual(planPaneSplit(request(main, [...aux].reverse())));
	});
});
