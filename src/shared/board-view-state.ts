/**
 * The on-disk shape of one board's board-view state (`board-views.json`).
 *
 * A list of saved views (spec D21). Slots always point at an unnamed working view;
 * named views are presets beside them that the user applies and updates explicitly.
 * See decisions/2026/11/21/named-saved-views-are-presets.md.
 */

export type BoardKind = "project" | "space";
export type BoardFormFactor = "wide" | "narrow";

/** Which board a state file belongs to. */
export interface BoardRef {
	kind: BoardKind;
	id: string;
}

export interface SavedBoardView {
	id: string;
	/** `null` for a working view a slot shows; a string for a named preset. */
	name: string | null;
	viewType: string;
	query: string;
	/** Layout per view type, so switching Kanban → Table → Kanban keeps both. */
	layouts: Record<string, unknown>;
}

export interface BoardViewState {
	version: 1;
	slots: Record<BoardFormFactor, string>;
	savedViews: SavedBoardView[];
}

export const KANBAN_VIEW_ID = "builtin:kanban";
export const ATTENTION_VIEW_ID = "builtin:attention";
export const DEFAULT_SAVED_VIEW_ID = "sv-default";

export function defaultBoardViewState(): BoardViewState {
	return {
		version: 1,
		slots: { wide: DEFAULT_SAVED_VIEW_ID, narrow: DEFAULT_SAVED_VIEW_ID },
		savedViews: [{ id: DEFAULT_SAVED_VIEW_ID, name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} }],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * Accept whatever is on disk and return a usable state. Anything unreadable falls
 * back to the default rather than failing the board: a view preference is never
 * worth an empty board. A slot pointing at a missing saved view is re-pointed.
 */
export function normalizeBoardViewState(value: unknown): BoardViewState {
	if (!isRecord(value) || value.version !== 1) return defaultBoardViewState();
	const savedViews = Array.isArray(value.savedViews)
		? value.savedViews.map(normalizeSavedView).filter((view): view is SavedBoardView => view !== null)
		: [];
	if (savedViews.length === 0) return defaultBoardViewState();
	// A slot shows a working view, never a named preset: re-add one if a hand edit left none.
	if (!savedViews.some((view) => view.name === null)) savedViews.unshift(defaultBoardViewState().savedViews[0]);
	const working = savedViews.filter((view) => view.name === null);
	const workingIds = new Set(working.map((view) => view.id));
	const slots = isRecord(value.slots) ? value.slots : {};
	const slotFor = (formFactor: BoardFormFactor) => {
		const id = slots[formFactor];
		return typeof id === "string" && workingIds.has(id) ? id : working[0].id;
	};
	return { version: 1, slots: { wide: slotFor("wide"), narrow: slotFor("narrow") }, savedViews };
}

/** The saved view a form factor currently shows. Always defined on a normalized state. */
export function activeSavedView(state: BoardViewState, formFactor: BoardFormFactor): SavedBoardView {
	return state.savedViews.find((view) => view.id === state.slots[formFactor]) ?? state.savedViews[0];
}

const OTHER_FORM_FACTOR: Record<BoardFormFactor, BoardFormFactor> = { wide: "narrow", narrow: "wide" };

/**
 * Both slots start on one shared saved view. The first change made in one form
 * factor forks a copy for that slot, so view type and layout stay per form
 * factor (D2) while an untouched board keeps a single entry.
 */
function updateActive(
	state: BoardViewState,
	formFactor: BoardFormFactor,
	update: (view: SavedBoardView) => SavedBoardView,
): BoardViewState {
	const active = activeSavedView(state, formFactor);
	if (state.slots[OTHER_FORM_FACTOR[formFactor]] !== active.id) {
		return { ...state, savedViews: state.savedViews.map((view) => (view.id === active.id ? update(view) : view)) };
	}
	let forkId = `sv-${formFactor}`;
	for (let n = 2; state.savedViews.some((view) => view.id === forkId); n++) forkId = `sv-${formFactor}-${n}`;
	const fork = update({ ...active, id: forkId, layouts: { ...active.layouts } });
	return { ...state, slots: { ...state.slots, [formFactor]: forkId }, savedViews: [...state.savedViews, fork] };
}

export function withViewType(state: BoardViewState, formFactor: BoardFormFactor, viewType: string): BoardViewState {
	return updateActive(state, formFactor, (view) => ({ ...view, viewType }));
}

export function withLayout(
	state: BoardViewState,
	formFactor: BoardFormFactor,
	viewType: string,
	layout: unknown,
): BoardViewState {
	return updateActive(state, formFactor, (view) => ({ ...view, layouts: { ...view.layouts, [viewType]: layout } }));
}

/** The named presets, in the order the user saved them. */
export function namedSavedViews(state: BoardViewState): SavedBoardView[] {
	return state.savedViews.filter((view) => view.name !== null);
}

/** Longest name a saved view keeps; the switcher truncates long ones anyway. */
export const SAVED_VIEW_NAME_MAX = 60;

export function cleanSavedViewName(name: string): string {
	return name.trim().replace(/\s+/g, " ").slice(0, SAVED_VIEW_NAME_MAX);
}

function nextNamedViewId(state: BoardViewState): string {
	const taken = new Set(state.savedViews.map((view) => view.id));
	for (let n = 1; ; n++) if (!taken.has(`sv-named-${n}`)) return `sv-named-${n}`;
}

function cloneLayouts(layouts: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(layouts)) as Record<string, unknown>;
}

/** Saves what a form factor shows, plus the board query, as a new named view. */
export function withNamedViewAdded(
	state: BoardViewState,
	formFactor: BoardFormFactor,
	name: string,
	query: string,
): { state: BoardViewState; id: string } {
	const active = activeSavedView(state, formFactor);
	const id = nextNamedViewId(state);
	const view: SavedBoardView = { id, name: cleanSavedViewName(name), viewType: active.viewType, query: query.trim(), layouts: cloneLayouts(active.layouts) };
	return { state: { ...state, savedViews: [...state.savedViews, view] }, id };
}

function mapNamed(state: BoardViewState, id: string, update: (view: SavedBoardView) => SavedBoardView): BoardViewState {
	if (!state.savedViews.some((view) => view.id === id && view.name !== null)) return state;
	return { ...state, savedViews: state.savedViews.map((view) => (view.id === id ? update(view) : view)) };
}

/** Overwrites a named view with what the form factor shows now. */
export function withNamedViewUpdated(state: BoardViewState, formFactor: BoardFormFactor, id: string, query: string): BoardViewState {
	const active = activeSavedView(state, formFactor);
	return mapNamed(state, id, (view) => ({ ...view, viewType: active.viewType, query: query.trim(), layouts: cloneLayouts(active.layouts) }));
}

export function withNamedViewRenamed(state: BoardViewState, id: string, name: string): BoardViewState {
	const clean = cleanSavedViewName(name);
	if (!clean) return state;
	return mapNamed(state, id, (view) => ({ ...view, name: clean }));
}

export function withoutNamedView(state: BoardViewState, id: string): BoardViewState {
	if (!state.savedViews.some((view) => view.id === id && view.name !== null)) return state;
	return { ...state, savedViews: state.savedViews.filter((view) => view.id !== id) };
}

/**
 * Loads a named view's view type and layouts into the form factor's working view.
 * The query is the caller's to apply: the board query lives in memory, not here.
 */
export function withNamedViewApplied(state: BoardViewState, formFactor: BoardFormFactor, id: string): BoardViewState {
	const named = state.savedViews.find((view) => view.id === id && view.name !== null);
	if (!named) return state;
	return updateActive(state, formFactor, (view) => ({
		...view,
		viewType: named.viewType,
		layouts: { ...view.layouts, ...cloneLayouts(named.layouts) },
	}));
}

/** True when the form factor no longer shows what the named view holds: its view type, that view's layout, or the query. */
export function namedViewModified(state: BoardViewState, formFactor: BoardFormFactor, id: string, query: string): boolean {
	const named = state.savedViews.find((view) => view.id === id && view.name !== null);
	if (!named) return false;
	const active = activeSavedView(state, formFactor);
	if (active.viewType !== named.viewType || query.trim() !== named.query) return true;
	return JSON.stringify(active.layouts[named.viewType] ?? null) !== JSON.stringify(named.layouts[named.viewType] ?? null);
}

/** A space id becomes a file name, so only the generated `sp_<uuid>` alphabet is accepted. */
export function isSafeBoardId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
