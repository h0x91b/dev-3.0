/**
 * QA (independent) tests for named saved views in src/shared/board-view-state.ts.
 * They target what board-view-state.test.ts "named saved views" does not: fuzzed
 * input, duplicate ids, odd names, op sequences, a round trip through the pre-change
 * build, and Revert when a named view has no layout of its own.
 */
import { describe, expect, it } from "vitest";
import {
	activeSavedView,
	applyNamedViewChange,
	namedViewAddChange,
	withNamedViewsFrom,
	type NamedViewChange,
	cleanSavedViewName,
	defaultBoardViewState,
	KANBAN_VIEW_ID,
	namedSavedViews,
	namedViewModified,
	normalizeBoardViewState,
	SAVED_VIEW_NAME_MAX,
	withLayout,
	withNamedViewAdded,
	withNamedViewApplied,
	withNamedViewRenamed,
	withNamedViewUpdated,
	withoutNamedView,
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

describe("QA: normalizeBoardViewState fuzz", () => {
	it("never throws and always yields slots on working views, for 3000 random shapes", () => {
		const r = rng(1234);
		for (let i = 0; i < 3000; i++) {
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

	it("keeps every well-formed named view it is given, in order", () => {
		const r = rng(7);
		for (let i = 0; i < 500; i++) {
			const raw = randomState(r) as { savedViews?: unknown };
			const state = normalizeBoardViewState(raw);
			const expected = Array.isArray(raw?.savedViews)
				? raw.savedViews.filter((v): v is { id: string; name: string } =>
					typeof v === "object" && v !== null && !Array.isArray(v)
					&& typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id !== ""
					&& typeof (v as { name?: unknown }).name === "string").map((v) => v.id)
				: [];
			// When the input is not version 1 at all, everything falls back to the default.
			if ((raw as { version?: unknown })?.version !== 1) continue;
			expect(namedSavedViews(state).map((v) => v.id), `iteration ${i}`).toEqual(expected);
		}
	});

	it("does not let a __proto__ key in layouts pollute Object.prototype", () => {
		const raw = JSON.parse('{"version":1,"slots":{"wide":"a","narrow":"a"},"savedViews":[{"id":"a","name":null,"viewType":"builtin:kanban","query":"","layouts":{"__proto__":{"polluted":true}}}]}');
		normalizeBoardViewState(raw);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// hand-edited and odd files
// ---------------------------------------------------------------------------

describe("QA: odd files on disk", () => {
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

	it("a layout change on such a file does not rewrite the named preset", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "x", narrow: "y" },
			savedViews: [
				{ id: "y", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
				{ id: "x", name: "Preset", viewType: "ext:list", query: "beta", layouts: {} },
				{ id: "x", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
			],
		});
		const next = withLayout(state, "wide", KANBAN_VIEW_ID, { collapsed: true });
		const preset = next.savedViews.find((v) => v.name === "Preset")!;
		expect(preset.layouts).toEqual({});
	});

	it("keeps a named view whose name is an empty string as named (documented behavior probe)", () => {
		// cleanSavedViewName/withNamedViewRenamed refuse "" but normalize accepts it.
		// The switcher then lists an option with an empty label. Spec ambiguity: flagged, not decided.
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "w", narrow: "w" },
			savedViews: [
				{ id: "w", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
				{ id: "e", name: "", viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
			],
		});
		expect(namedSavedViews(state).map((v) => v.id)).toEqual(["e"]);
		expectSlotsOnWorkingViews(state, "empty name");
	});

	it("turns a non-string name into a working view, and slots may then land on it", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "n", narrow: "n" },
			savedViews: [
				{ id: "w", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
				{ id: "n", name: 42, viewType: "ext:list", query: "beta", layouts: {} },
			],
		});
		expect(namedSavedViews(state)).toEqual([]);
		expectSlotsOnWorkingViews(state, "numeric name");
	});

	it("keeps only working views in slots when the only working view has an empty id", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "", narrow: "" },
			savedViews: [
				{ id: "", name: null },
				{ id: "n", name: "Preset" },
			],
		});
		expectSlotsOnWorkingViews(state, "empty working id");
		expect(namedSavedViews(state).map((v) => v.id)).toEqual(["n"]);
	});
});

// ---------------------------------------------------------------------------
// op sequences
// ---------------------------------------------------------------------------

describe("QA: random op sequences keep the invariants", () => {
	it("slots stay on working views, named ids stay unique, and only add/delete change the named count", () => {
		const r = rng(2026);
		for (let run = 0; run < 300; run++) {
			let state = defaultBoardViewState();
			for (let step = 0; step < 40; step++) {
				const ff = FORM_FACTORS[Math.floor(r() * 2)];
				const named = namedSavedViews(state);
				const anyNamed = named.length ? named[Math.floor(r() * named.length)].id : "missing";
				const before = named.length;
				const op = Math.floor(r() * 8);
				let label = "";
				switch (op) {
					case 0: label = "viewType"; state = withViewType(state, ff, ["builtin:kanban", "ext:list", "builtin:table"][Math.floor(r() * 3)]); break;
					case 1: label = "layout"; state = withLayout(state, ff, "ext:list", { sort: String(Math.floor(r() * 3)) }); break;
					case 2: label = "add"; state = withNamedViewAdded(state, ff, `n${step}`, "q").state; break;
					case 3: label = "apply"; state = withNamedViewApplied(state, ff, anyNamed); break;
					case 4: label = "update"; state = withNamedViewUpdated(state, ff, anyNamed, "q2"); break;
					case 5: label = "rename"; state = withNamedViewRenamed(state, anyNamed, r() < 0.2 ? "   " : `r${step}`); break;
					case 6: label = "delete"; state = withoutNamedView(state, anyNamed); break;
					default: label = "delete-working"; state = withoutNamedView(state, state.slots[ff]); break;
				}
				const ctx = `run ${run} step ${step} op ${label}`;
				expectSlotsOnWorkingViews(state, ctx);
				const ids = state.savedViews.map((v) => v.id);
				expect(new Set(ids).size, `${ctx}: ids unique`).toBe(ids.length);
				const after = namedSavedViews(state).length;
				if (label === "add") expect(after, ctx).toBe(before + 1);
				else if (label === "delete" && anyNamed !== "missing") expect(after, ctx).toBe(before - 1);
				else expect(after, ctx).toBe(before);
				// The working views never carry a query: the board query is session memory.
				expect(state.savedViews.filter((v) => v.name === null).every((v) => v.query === ""), ctx).toBe(true);
				// Round trip through disk keeps everything.
				expect(normalizeBoardViewState(JSON.parse(JSON.stringify(state))), ctx).toEqual(state);
			}
		}
	});

	it("an applied named view does not share layout objects with the working view", () => {
		let state = withNamedViewAdded(withLayout(withViewType(defaultBoardViewState(), "wide", "ext:list"), "wide", "ext:list", { sort: "seq", cols: [1] }), "wide", "A", "").state;
		const id = namedSavedViews(state)[0].id;
		state = withNamedViewApplied(state, "narrow", id);
		const working = activeSavedView(state, "narrow").layouts["ext:list"] as { cols: number[] };
		working.cols.push(2);
		expect((namedSavedViews(state)[0].layouts["ext:list"] as { cols: number[] }).cols).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// Revert / apply when the named view has no layout for its own view type
// ---------------------------------------------------------------------------

describe("QA: apply restores what the named view holds", () => {
	it("Revert (re-apply) clears the modified mark after a layout change on a view saved with the default layout", () => {
		// The user saves "A" without ever touching the layout: layouts is {}.
		let state = defaultBoardViewState();
		const added = withNamedViewAdded(state, "wide", "A", "");
		state = added.state;
		// Then changes the layout: "A •".
		state = withLayout(state, "wide", KANBAN_VIEW_ID, { collapsed: ["done"] });
		expect(namedViewModified(state, "wide", added.id, "")).toBe(true);
		// Revert re-applies "A". It merges {} over the working layouts, so the change stays.
		state = withNamedViewApplied(state, "wide", added.id);
		expect(namedViewModified(state, "wide", added.id, "")).toBe(false);
	});

	it("applying a named view saved with the default layout is not modified at once", () => {
		// The working view already has a list layout; the preset "B" was saved on List with none.
		let state = withViewType(defaultBoardViewState(), "wide", "ext:list");
		const added = withNamedViewAdded(state, "wide", "B", "");
		state = withLayout(added.state, "wide", "ext:list", { sort: "seq" });
		state = withViewType(state, "wide", KANBAN_VIEW_ID);
		state = withNamedViewApplied(state, "wide", added.id);
		expect(activeSavedView(state, "wide").viewType).toBe("ext:list");
		expect(namedViewModified(state, "wide", added.id, "")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// older-version simulation
// ---------------------------------------------------------------------------

/**
 * Verbatim copy of normalize + updateActive/withViewType/withLayout from the build
 * before this change (git show 2b7bb8c22:src/shared/board-view-state.ts, the merge
 * base with upstream/main). Kept inline so the test needs no git history.
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

describe("QA: a state with named views survives a trip through the older build", () => {
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

	it("an old build editing a state that the new build normalized keeps the preset byte-identical", () => {
		const start = richNewState();
		let s = old.normalize(JSON.parse(JSON.stringify(start)));
		for (let i = 0; i < 10; i++) {
			s = old.withLayout(s, i % 2 ? "wide" : "narrow", "ext:list", { sort: String(i) });
			s = old.withViewType(s, i % 2 ? "narrow" : "wide", i % 3 ? "ext:list" : KANBAN_VIEW_ID);
		}
		const back = normalizeBoardViewState(JSON.parse(JSON.stringify(s)));
		expect(JSON.stringify(namedSavedViews(back))).toBe(JSON.stringify(namedSavedViews(start)));
	});
});

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

describe("QA: names", () => {
	it("keeps Unicode names intact", () => {
		for (const name of ["Задачи", "Tâches à faire", "バグ", "😀 Party", "עברית", "é combining"]) {
			expect(cleanSavedViewName(name)).toBe(name);
		}
	});

	it("collapses tabs, newlines and non-breaking spaces into one space", () => {
		expect(cleanSavedViewName("\tMy\n\nview  x ")).toBe("My view x");
	});

	it("never cuts a 60+ char name in the middle of a surrogate pair", () => {
		const name = `${"a".repeat(SAVED_VIEW_NAME_MAX - 1)}😀tail`;
		const clean = cleanSavedViewName(name);
		expect(clean.length).toBeLessThanOrEqual(SAVED_VIEW_NAME_MAX);
		// A lone high surrogate is not well-formed UTF-16 and JSON-encodes as \ud83d.
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(clean), `clean=${JSON.stringify(clean)}`).toBe(false);
	});

	it("caps a 200-char name at SAVED_VIEW_NAME_MAX on add and on rename", () => {
		const long = "x".repeat(200);
		const added = withNamedViewAdded(defaultBoardViewState(), "wide", long, "");
		expect(namedSavedViews(added.state)[0].name).toHaveLength(SAVED_VIEW_NAME_MAX);
		const renamed = withNamedViewRenamed(added.state, added.id, "y".repeat(200));
		expect(namedSavedViews(renamed)[0].name).toBe("y".repeat(SAVED_VIEW_NAME_MAX));
	});

	it("ids are random sv-named-<16 hex> and never reused after a delete", () => {
		let state = defaultBoardViewState();
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const added = withNamedViewAdded(state, "wide", `N${i}`, "");
			expect(added.id).toMatch(/^sv-named-[0-9a-f]{16}$/);
			expect(seen.has(added.id)).toBe(false);
			seen.add(added.id);
			// Delete every other one so a lowest-free scheme would reuse ids.
			state = i % 2 ? withoutNamedView(added.state, added.id) : added.state;
		}
	});
});

// ---------------------------------------------------------------------------
// host-side change API: applyNamedViewChange and withNamedViewsFrom
// ---------------------------------------------------------------------------

describe("QA: applyNamedViewChange with junk payloads", () => {
	it("never throws on a record-shaped change and keeps the invariants, for 3000 random changes", () => {
		const r = rng(31337);
		let state = withNamedViewAdded(defaultBoardViewState(), "wide", "Seed", "").state;
		for (let i = 0; i < 3000; i++) {
			const ids = [...state.savedViews.map((v) => v.id), "missing", ""];
			const anyId = () => (r() < 0.8 ? ids[Math.floor(r() * ids.length)] : randomJson(r, 2));
			const kinds = ["add", "update", "rename", "delete", "other"];
			const change: Record<string, unknown> = { kind: r() < 0.9 ? kinds[Math.floor(r() * kinds.length)] : randomJson(r, 2) };
			if (r() < 0.8) change.id = anyId();
			if (r() < 0.6) change.name = r() < 0.6 ? `n${i}` : randomJson(r, 2);
			if (r() < 0.6) change.viewType = r() < 0.6 ? "ext:list" : randomJson(r, 2);
			if (r() < 0.6) change.query = r() < 0.6 ? " q " : randomJson(r, 2);
			if (r() < 0.6) change.layouts = r() < 0.6 ? { "ext:list": { sort: "seq" } } : randomJson(r, 2);
			if (r() < 0.6) change.view = r() < 0.5 ? { id: r() < 0.5 ? `sv-x-${i}` : anyId(), name: r() < 0.7 ? `v${i}` : randomJson(r, 2), viewType: "ext:list", query: "", layouts: {} } : randomJson(r, 2);
			const json = JSON.parse(JSON.stringify(change));
			let next: BoardViewState;
			try {
				next = normalizeBoardViewState(applyNamedViewChange(state, json as NamedViewChange));
			} catch (err) {
				throw new Error(`iteration ${i} threw ${String(err)} on ${JSON.stringify(json)}`);
			}
			expectSlotsOnWorkingViews(next, `iteration ${i} change=${JSON.stringify(json)}`);
			const ids2 = next.savedViews.map((v) => v.id);
			expect(new Set(ids2).size, `iteration ${i}: ids unique after ${JSON.stringify(json)}`).toBe(ids2.length);
			for (const named of namedSavedViews(next)) expect(named.name!.length, `iteration ${i}`).toBeGreaterThan(0);
			// Working views are never touched by a named change.
			expect(next.savedViews.filter((v) => v.name === null), `iteration ${i}`).toEqual(state.savedViews.filter((v) => v.name === null));
			state = next;
		}
	});

	it("an add whose view carries a name of only spaces, or a non-string name, is refused", () => {
		const base = defaultBoardViewState();
		for (const name of ["   ", "", 5, null, { x: 1 }]) {
			const change = { kind: "add", view: { id: "sv-named-x", name, viewType: KANBAN_VIEW_ID, query: "", layouts: {} } } as unknown as NamedViewChange;
			expect(applyNamedViewChange(base, change)).toBe(base);
		}
	});

	it("an add cleans its name and trims its query, as the renderer does", () => {
		const change = namedViewAddChange(defaultBoardViewState(), "wide", "  a \t b  ", "  status:todo  ");
		const next = applyNamedViewChange(defaultBoardViewState(), { kind: "add", view: { ...change.view, name: "  a \t b  ", query: "  status:todo  " } });
		expect(namedSavedViews(next)[0]).toMatchObject({ name: "a b", query: "status:todo" });
	});
});

describe("QA: withNamedViewsFrom", () => {
	it("takes named views only from the source, whatever the incoming state carries", () => {
		const source = withNamedViewAdded(defaultBoardViewState(), "wide", "OnDisk", "").state;
		const incoming = withNamedViewAdded(withLayout(defaultBoardViewState(), "wide", "ext:list", { a: 1 }), "wide", "Stale", "").state;
		const merged = withNamedViewsFrom(incoming, source);
		expect(namedSavedViews(merged).map((v) => v.name)).toEqual(["OnDisk"]);
		expect(activeSavedView(merged, "wide").layouts).toEqual({ "ext:list": { a: 1 } });
		expectSlotsOnWorkingViews(merged, "merged");
	});

	it("is idempotent", () => {
		const source = richNewState();
		const incoming = withLayout(defaultBoardViewState(), "narrow", "ext:list", { b: 2 });
		const once = withNamedViewsFrom(incoming, source);
		expect(withNamedViewsFrom(once, source)).toEqual(once);
	});
});

describe("QA: apply is a no-op when nothing would change", () => {
	it("returns the same object for a second apply of an unmodified view", () => {
		const added = withNamedViewAdded(withLayout(withViewType(defaultBoardViewState(), "wide", "ext:list"), "wide", "ext:list", { s: 1 }), "wide", "A", "");
		const once = withNamedViewApplied(added.state, "wide", added.id);
		expect(withNamedViewApplied(once, "wide", added.id)).toBe(once);
	});

	it("does not fork the shared working view when applying on a board whose both slots already match", () => {
		// Both slots share sv-default; a no-op apply on narrow must not create sv-narrow.
		const added = withNamedViewAdded(defaultBoardViewState(), "wide", "A", "");
		expect(withNamedViewApplied(added.state, "narrow", added.id)).toBe(added.state);
	});
});
