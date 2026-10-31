/**
 * The on-disk shape of one board's board-view state (`board-views.json`).
 *
 * The format is already a list of saved views (spec D21): v1 keeps exactly one,
 * implicit, and both form-factor slots point at it. Named saved views later add
 * entries to the list without a migration.
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
	/** `null` for the implicit default view; named saved views come later. */
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
	const ids = new Set(savedViews.map((view) => view.id));
	const slots = isRecord(value.slots) ? value.slots : {};
	const slotFor = (formFactor: BoardFormFactor) => {
		const id = slots[formFactor];
		return typeof id === "string" && ids.has(id) ? id : savedViews[0].id;
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

/** A space id becomes a file name, so only the generated `sp_<uuid>` alphabet is accepted. */
export function isSafeBoardId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
