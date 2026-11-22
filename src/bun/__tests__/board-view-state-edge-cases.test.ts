/**
 * Edge cases for named saved views beyond board-view-state.test.ts: fuzzed input, a shared id,
 * a round trip through the older build, and names that end in an emoji.
 */
import { describe, expect, it } from "vitest";
import {
	activeSavedView,
	cleanSavedViewName,
	defaultBoardViewState,
	KANBAN_VIEW_ID,
	namedSavedViews,
	normalizeBoardViewState,
	SAVED_VIEW_NAME_MAX,
	withLayout,
	withNamedViewAdded,
	withViewType,
	type BoardFormFactor,
	type BoardViewState,
	type SavedBoardView,
} from "../../shared/board-view-state";

const FORM_FACTORS: BoardFormFactor[] = ["wide", "narrow"];

/** Deterministic PRNG (mulberry32) so a failing seed reproduces. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function expectSlotsOnWorkingViews(state: BoardViewState, context: string) {
	for (const ff of FORM_FACTORS) {
		const slotId = state.slots[ff];
		const target = state.savedViews.filter((view) => view.id === slotId);
		expect(target.length, `${context}: slot ${ff} -> ${slotId} must match exactly one view`).toBe(1);
		expect(target[0].name, `${context}: slot ${ff} must point at a working view`).toBeNull();
		expect(activeSavedView(state, ff).name, `${context}: active ${ff} must be a working view`).toBeNull();
	}
}

// ---------------------------------------------------------------------------
// normalize fuzzing
// ---------------------------------------------------------------------------

function randomJson(r: () => number, depth = 0): unknown {
	const pick = Math.floor(r() * (depth > 2 ? 6 : 8));
	switch (pick) {
		case 0: return null;
		case 1: return r() < 0.5;
		case 2: return Math.floor(r() * 2000) - 1000;
		case 3: return ["", "x", "sv-default", "named", "  ", "\u0000", "😀"][Math.floor(r() * 7)];
		case 4: return undefined;
		case 5: return NaN;
		case 6: return Array.from({ length: Math.floor(r() * 4) }, () => randomJson(r, depth + 1));
		default: {
			const out: Record<string, unknown> = {};
			for (let i = 0; i < Math.floor(r() * 4); i++) out[["a", "b", "id", "name", "__proto__"][Math.floor(r() * 5)]] = randomJson(r, depth + 1);
			return out;
		}
	}
}

/** A view-ish object: each field is sometimes right, sometimes junk. Ids are unique per call. */
function randomView(r: () => number, id: string): unknown {
	const junk = () => randomJson(r, 2);
	const view: Record<string, unknown> = {};
	if (r() < 0.9) view.id = r() < 0.95 ? id : junk();
	if (r() < 0.8) {
		const n = r();
		view.name = n < 0.35 ? null : n < 0.65 ? `Name ${id}` : n < 0.75 ? "" : n < 0.85 ? 42 : junk();
	}
	if (r() < 0.8) view.viewType = r() < 0.7 ? ["builtin:kanban", "ext:list", "builtin:table", ""][Math.floor(r() * 4)] : junk();
	if (r() < 0.8) view.query = r() < 0.7 ? "status:todo" : junk();
	if (r() < 0.8) view.layouts = r() < 0.7 ? { "ext:list": { sort: "seq" } } : junk();
	return r() < 0.9 ? view : junk();
}

function randomState(r: () => number): unknown {
	if (r() < 0.05) return randomJson(r);
	const count = Math.floor(r() * 6);
	const ids = Array.from({ length: count }, (_, i) => `v${i}`);
	const slotVal = () => (r() < 0.6 && ids.length ? ids[Math.floor(r() * ids.length)] : randomJson(r, 2));
	return {
		version: r() < 0.9 ? 1 : randomJson(r, 2),
		slots: r() < 0.85 ? { wide: slotVal(), narrow: slotVal() } : randomJson(r, 2),
		savedViews: r() < 0.9 ? ids.map((id) => randomView(r, id)) : randomJson(r, 2),
	};
}

describe("normalizeBoardViewState fuzz", () => {
	it("never throws and always yields slots on working views, for 300 random shapes", () => {
		const r = rng(1234);
		for (let i = 0; i < 300; i++) {
			const raw = randomState(r);
			let state: BoardViewState;
			try {
				state = normalizeBoardViewState(raw);
			} catch (err) {
				throw new Error(`seed 1234 iteration ${i} threw: ${String(err)} on ${JSON.stringify(raw)}`);
			}
			expect(state.version).toBe(1);
			expect(state.savedViews.length).toBeGreaterThan(0);
			expectSlotsOnWorkingViews(state, `iteration ${i} raw=${JSON.stringify(raw)}`);
		}
	});

	it("is idempotent and JSON-stable: normalize(JSON(normalize(x))) equals normalize(x)", () => {
		const r = rng(99);
		for (let i = 0; i < 1500; i++) {
			// Disk input is JSON, so feed JSON (NaN and undefined cannot reach normalize from a file).
			const once = normalizeBoardViewState(JSON.parse(JSON.stringify(randomState(r)) ?? "null"));
			const twice = normalizeBoardViewState(JSON.parse(JSON.stringify(once)));
			expect(twice, `iteration ${i}`).toEqual(once);
		}
	});

});

// ---------------------------------------------------------------------------
// hand-edited and odd files
// ---------------------------------------------------------------------------

describe("odd files on disk", () => {
	it("never shows a named view in a slot when a named and a working view share an id", () => {
		// A hand edit or merge conflict can duplicate an id. The slot id "x" is a working id,
		// but activeSavedView picks the first view with that id, which is the named preset.
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "x", narrow: "x" },
			savedViews: [
				{ id: "x", name: "Preset", viewType: "ext:list", query: "beta", layouts: {} },
				{ id: "x", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
			],
		});
		expect(activeSavedView(state, "wide").name).toBeNull();
	});

});

// ---------------------------------------------------------------------------
// op sequences
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Revert / apply when the named view has no layout for its own view type
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// older-version simulation
// ---------------------------------------------------------------------------

/**
 * Verbatim copy of normalize, updateActive, withViewType and withLayout from 2b7bb8c22, the
 * build before named views, kept inline so the test needs no git history.
 */
const old = (() => {
	const DEFAULT = "sv-default";
	const def = (): BoardViewState => ({ version: 1, slots: { wide: DEFAULT, narrow: DEFAULT }, savedViews: [{ id: DEFAULT, name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} }] });
	const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
	function normalizeSavedView(value: unknown): SavedBoardView | null {
		if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
		return {
			id: value.id,
			name: typeof value.name === "string" ? value.name : null,
			viewType: typeof value.viewType === "string" && value.viewType ? value.viewType : KANBAN_VIEW_ID,
			query: typeof value.query === "string" ? value.query : "",
			layouts: isRecord(value.layouts) ? { ...value.layouts } : {},
		};
	}
	function normalize(value: unknown): BoardViewState {
		if (!isRecord(value) || value.version !== 1) return def();
		const savedViews = Array.isArray(value.savedViews) ? value.savedViews.map(normalizeSavedView).filter((v): v is SavedBoardView => v !== null) : [];
		if (savedViews.length === 0) return def();
		const ids = new Set(savedViews.map((v) => v.id));
		const slots = isRecord(value.slots) ? value.slots : {};
		const slotFor = (ff: BoardFormFactor) => {
			const id = slots[ff];
			return typeof id === "string" && ids.has(id) ? id : savedViews[0].id;
		};
		return { version: 1, slots: { wide: slotFor("wide"), narrow: slotFor("narrow") }, savedViews };
	}
	const active = (state: BoardViewState, ff: BoardFormFactor) => state.savedViews.find((v) => v.id === state.slots[ff]) ?? state.savedViews[0];
	const other: Record<BoardFormFactor, BoardFormFactor> = { wide: "narrow", narrow: "wide" };
	function updateActive(state: BoardViewState, ff: BoardFormFactor, update: (v: SavedBoardView) => SavedBoardView): BoardViewState {
		const a = active(state, ff);
		if (state.slots[other[ff]] !== a.id) return { ...state, savedViews: state.savedViews.map((v) => (v.id === a.id ? update(v) : v)) };
		let forkId = `sv-${ff}`;
		for (let n = 2; state.savedViews.some((v) => v.id === forkId); n++) forkId = `sv-${ff}-${n}`;
		const fork = update({ ...a, id: forkId, layouts: { ...a.layouts } });
		return { ...state, slots: { ...state.slots, [ff]: forkId }, savedViews: [...state.savedViews, fork] };
	}
	return {
		normalize,
		withViewType: (s: BoardViewState, ff: BoardFormFactor, viewType: string) => updateActive(s, ff, (v) => ({ ...v, viewType })),
		withLayout: (s: BoardViewState, ff: BoardFormFactor, vt: string, layout: unknown) => updateActive(s, ff, (v) => ({ ...v, layouts: { ...v.layouts, [vt]: layout } })),
	};
})();

function richNewState(): BoardViewState {
	let state = defaultBoardViewState();
	state = withViewType(state, "wide", "ext:list");
	state = withLayout(state, "wide", "ext:list", { sort: "seq" });
	const a = withNamedViewAdded(state, "wide", "Alpha", "alpha");
	state = withLayout(a.state, "narrow", KANBAN_VIEW_ID, { collapsed: true });
	const b = withNamedViewAdded(state, "narrow", "Beta", "beta");
	return b.state;
}

describe("a state with named views survives a trip through the older build", () => {
	it("old normalize plus old edits on both form factors lose no named view, and new normalize keeps slots on working views", () => {
		const start = richNewState();
		const namedBefore = namedSavedViews(start);
		let s = old.normalize(JSON.parse(JSON.stringify(start)));
		s = old.withViewType(s, "wide", KANBAN_VIEW_ID);
		s = old.withLayout(s, "narrow", "ext:list", { sort: "title" });
		s = old.withLayout(s, "wide", "ext:list", { sort: "x" });
		const back = normalizeBoardViewState(JSON.parse(JSON.stringify(s)));
		expect(namedSavedViews(back)).toEqual(namedBefore);
		expectSlotsOnWorkingViews(back, "after old round trip");
	});

	// Accepted (decisions/2026/11/21/named-saved-views-are-presets.md, Risks): only a hand-edited file puts a
	// named view first, since this build always keeps a working view ahead of the presets. The old build then
	// forks the preset with its name, so a second "Preset" appears. Pinned so a change in it is noticed.
	it("an old build whose slot fell back to a named view forks the preset into a same-named copy (accepted)", () => {
		// A file where a slot names a missing view and the first entry is a named view:
		// the old normalize re-points to savedViews[0], which is the preset.
		const raw = {
			version: 1,
			slots: { wide: "gone", narrow: "gone" },
			savedViews: [
				{ id: "sv-named-1", name: "Preset", viewType: "ext:list", query: "beta", layouts: { "ext:list": { sort: "seq" } } },
				{ id: "sv-default", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
			],
		};
		let s = old.normalize(raw);
		s = old.withLayout(s, "wide", "ext:list", { sort: "title" });
		const back = normalizeBoardViewState(JSON.parse(JSON.stringify(s)));
		expectSlotsOnWorkingViews(back, "old fallback");
		// The old build cannot know names, so it forks the preset for "wide". The fork keeps
		// the preset's name, which makes a second named view called "Preset".
		const names = namedSavedViews(back).map((v) => v.name);
		expect(names.filter((n) => n === "Preset").length, `named views after old edit: ${JSON.stringify(namedSavedViews(back))}`).toBe(2);
	});

});

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

describe("names", () => {
	it("never cuts a 60+ char name in the middle of a surrogate pair", () => {
		const name = `${"a".repeat(SAVED_VIEW_NAME_MAX - 1)}😀tail`;
		const clean = cleanSavedViewName(name);
		expect(clean.length).toBeLessThanOrEqual(SAVED_VIEW_NAME_MAX);
		// A lone high surrogate is not well-formed UTF-16 and JSON-encodes as \ud83d.
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(clean), `clean=${JSON.stringify(clean)}`).toBe(false);
	});

});
