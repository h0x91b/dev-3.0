/**
 * Where a `dev3 pane run` pane goes (seq 2124). Pure: no node/Bun imports.
 *
 * The rule, in one breath: the FIRST auxiliary pane takes half of the protected
 * main pane; every later one halves the existing auxiliary pane, in the
 * orientation, that leaves the tightest of the two resulting panes the most
 * usable. The main pane is never split again, and nothing outside the chosen
 * pane changes size. Why this scoring and not area or raw cells:
 * `decisions/2026/10/10/adaptive-pane-run-split.md`.
 */

import type { SplitOrientation } from "./split-tree";

/** Below either bound a pane is not worth opening — a strip, not a terminal. */
export const PANE_SPLIT_MIN_COLS = 40;
export const PANE_SPLIT_MIN_ROWS = 8;

/**
 * The shape a pane's usefulness is measured against: the classic terminal. A
 * pane scores by how many of these its tightest dimension holds, so 80 columns
 * and 24 rows count the same — which is what lets the score choose an orientation.
 */
export const PANE_SPLIT_REFERENCE_COLS = 80;
export const PANE_SPLIT_REFERENCE_ROWS = 24;

export interface PaneCells {
	cols: number;
	rows: number;
}

export interface PaneSplitCandidate extends PaneCells {
	paneId: string;
	/** Creation order, oldest first — the last, deterministic tie-break. */
	order: number;
}

export interface PaneSplitRequest {
	main: PaneSplitCandidate;
	/** The auxiliary panes that may be split. Never the main pane, never a stranger's pane. */
	auxiliary: PaneSplitCandidate[];
	/** Orientations the caller allows; `--below` narrows this to vertical only. */
	orientations: readonly SplitOrientation[];
	/** Cells a divider takes: 1 on tmux, 0 on the native SplitTree. */
	separator: number;
}

export interface PaneSplitOption {
	paneId: string;
	orientation: SplitOrientation;
	/** The pane that stays first (left/top) and the new pane, in cells. */
	kept: PaneCells;
	added: PaneCells;
	score: number;
}

export type PaneSplitPlan =
	| ({ kind: "split"; splitsMain: boolean } & PaneSplitOption)
	/** Nothing fits the minimum. `closest` is the best option that was refused, if any. */
	| { kind: "no-room"; closest: PaneSplitOption | null };

/**
 * The two halves a 50/50 split leaves, matching tmux's own `-l 50%` arithmetic
 * (measured on 3.6a): the new pane gets floor(n/2), the old one the rest minus
 * the divider.
 */
export function splitCells(pane: PaneCells, orientation: SplitOrientation, separator: number): { kept: PaneCells; added: PaneCells } {
	if (orientation === "horizontal") {
		const added = Math.floor(pane.cols / 2);
		return { kept: { cols: pane.cols - added - separator, rows: pane.rows }, added: { cols: added, rows: pane.rows } };
	}
	const added = Math.floor(pane.rows / 2);
	return { kept: { cols: pane.cols, rows: pane.rows - added - separator }, added: { cols: pane.cols, rows: added } };
}

function fits(pane: PaneCells): boolean {
	return pane.cols >= PANE_SPLIT_MIN_COLS && pane.rows >= PANE_SPLIT_MIN_ROWS;
}

/**
 * How usable a pane is, in integer units of (1/REF_COLS) reference terminals of
 * its tightest dimension: min(cols/80, rows/24) scaled by 80*24 so it never
 * needs a float comparison.
 */
export function paneUsability(pane: PaneCells): number {
	return Math.min(pane.cols * PANE_SPLIT_REFERENCE_ROWS, pane.rows * PANE_SPLIT_REFERENCE_COLS);
}

function optionFor(candidate: PaneSplitCandidate, orientation: SplitOrientation, separator: number): PaneSplitOption {
	const { kept, added } = splitCells(candidate, orientation, separator);
	return {
		paneId: candidate.paneId,
		orientation,
		kept,
		added,
		score: Math.min(paneUsability(kept), paneUsability(added)),
	};
}

/** Higher score, then the bigger pane, then right before below, then the older pane. */
function better(
	a: { option: PaneSplitOption; candidate: PaneSplitCandidate },
	b: { option: PaneSplitOption; candidate: PaneSplitCandidate },
): boolean {
	if (a.option.score !== b.option.score) return a.option.score > b.option.score;
	const areaA = a.candidate.cols * a.candidate.rows;
	const areaB = b.candidate.cols * b.candidate.rows;
	if (areaA !== areaB) return areaA > areaB;
	if (a.option.orientation !== b.option.orientation) return a.option.orientation === "horizontal";
	return a.candidate.order < b.candidate.order;
}

export function planPaneSplit(request: PaneSplitRequest): PaneSplitPlan {
	const { main, auxiliary, separator } = request;
	// Right before below, whatever order the caller listed them in.
	const orientations = (["horizontal", "vertical"] as const).filter((o) => request.orientations.includes(o));

	if (auxiliary.length === 0) {
		// The first pane is a fixed rule, not a score: right half when it fits, so
		// the agent keeps its full height; below only when right would make a strip.
		const options = orientations.map((o) => optionFor(main, o, separator));
		const chosen = options.find((option) => fits(option.kept) && fits(option.added));
		if (chosen) return { kind: "split", splitsMain: true, ...chosen };
		return { kind: "no-room", closest: options[0] ?? null };
	}

	let best: { option: PaneSplitOption; candidate: PaneSplitCandidate } | null = null;
	let closest: { option: PaneSplitOption; candidate: PaneSplitCandidate } | null = null;
	for (const candidate of auxiliary) {
		for (const orientation of orientations) {
			const entry = { option: optionFor(candidate, orientation, separator), candidate };
			if (!closest || better(entry, closest)) closest = entry;
			if (!fits(entry.option.kept) || !fits(entry.option.added)) continue;
			if (!best || better(entry, best)) best = entry;
		}
	}
	if (best) return { kind: "split", splitsMain: false, ...best.option };
	return { kind: "no-room", closest: closest?.option ?? null };
}

/** One line for an agent that was refused: what would have been left, and the floor. */
export function describeNoRoom(plan: Extract<PaneSplitPlan, { kind: "no-room" }>): string {
	const floor = `${PANE_SPLIT_MIN_COLS}x${PANE_SPLIT_MIN_ROWS}`;
	if (!plan.closest) return `no pane may be split here (the minimum is ${floor})`;
	const { kept, added } = plan.closest;
	const smaller = paneUsability(kept) <= paneUsability(added) ? kept : added;
	return `the best split would leave a ${smaller.cols}x${smaller.rows} pane, below the ${floor} minimum`;
}
