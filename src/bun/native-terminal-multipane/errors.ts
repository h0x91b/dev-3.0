/** Typed failures of the native multi-pane coordinator (seq 1283). */

export class CoordinatorExistsError extends Error {
	readonly code = "coordinator-exists";
	constructor(readonly coordinatorId: string) {
		super(`native multipane coordinator ${coordinatorId} is already live — recover it instead of creating a second one`);
		this.name = "CoordinatorExistsError";
	}
}

/** The on-disk record was replaced (or removed) by another coordinator epoch. */
export class CoordinatorGoneError extends Error {
	readonly code = "coordinator-gone";
	constructor(readonly coordinatorId: string) {
		super(`native multipane coordinator ${coordinatorId} no longer owns its record`);
		this.name = "CoordinatorGoneError";
	}
}

export class PaneNotFoundError extends Error {
	readonly code = "pane-not-found";
	constructor(readonly paneId: string) {
		super(`unknown logical pane ${paneId}`);
		this.name = "PaneNotFoundError";
	}
}

/** The writer's resize never showed up in the pane's republished record. */
export class PaneResizeNotAppliedError extends Error {
	readonly code = "pane-resize-not-applied";
	constructor(
		readonly paneId: string,
		requestedCols: number,
		requestedRows: number,
		actualCols: number,
		actualRows: number,
	) {
		super(`pane ${paneId} still reports ${actualCols}x${actualRows} after resizing to ${requestedCols}x${requestedRows}`);
		this.name = "PaneResizeNotAppliedError";
	}
}

/** An observer client tried to write to or resize a PTY it does not own. */
export class ObserverMutationError extends Error {
	readonly code = "observer-mutation";
	constructor(
		readonly paneId: string,
		readonly action: "input" | "resize",
	) {
		super(`pane ${paneId} is attached as observer — ${action} is writer-owned`);
		this.name = "ObserverMutationError";
	}
}

/**
 * A geometry-only layout change was rejected because the new tree's pane id set
 * differs from the coordinator's current one. Order changes also count as a
 * mismatch — the tree must be a pure ratio/shape change over the exact same set.
 */
export class LayoutPaneSetMismatchError extends Error {
	readonly code = "layout-pane-set-mismatch";
	constructor(
		readonly coordinatorId: string,
		readonly expectedPaneIds: readonly string[],
		readonly receivedPaneIds: readonly string[],
	) {
		super(
			`publishGeometry rejected for coordinator ${coordinatorId}: ` +
				`pane set [${receivedPaneIds.join(", ")}] does not match current [${expectedPaneIds.join(", ")}]`,
		);
		this.name = "LayoutPaneSetMismatchError";
	}
}
