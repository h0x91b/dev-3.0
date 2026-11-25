/** What src/bun/board-view-state-data.ts does with one board's two files, for the renderer suites' RPC mocks. */
import {
	applyNamedViewChange,
	namedSavedViews,
	namedViewChangeTakesName,
	withNamedViews,
	type BoardViewState,
	type NamedViewChange,
	type NamedViewChangeResult,
} from "../../../shared/board-view-state";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A plain save: the working views come from `state`, the named views stay as on `disk`. */
export function hostSave(disk: BoardViewState, state: BoardViewState): BoardViewState {
	return withNamedViews(clone(state), namedSavedViews(disk));
}

/** A named change against the file as it is now; a taken name is refused. */
export function hostNamedChange(disk: BoardViewState, change: NamedViewChange): NamedViewChangeResult {
	if (namedViewChangeTakesName(disk, change)) return { state: clone(disk), rejected: "name-taken" };
	return { state: withNamedViews(disk, namedSavedViews(applyNamedViewChange(disk, clone(change)))), rejected: null };
}
