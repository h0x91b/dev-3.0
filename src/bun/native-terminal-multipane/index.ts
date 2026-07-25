/**
 * Native multi-pane terminal session coordinator (seq 1283).
 *
 * Composes the existing persistent single-pane hosts into one logical
 * multi-pane session. No product caller, no native opt-in — tmux remains the
 * production default. See README.md and decision 169.
 */

export {
	defaultCoordinatorDeps,
	NativeMultipaneCoordinator,
	type CloseResult,
	type CoordinatorDeps,
	type PaneConnection,
	type PaneLaunchSpec,
	type PaneSnapshot,
} from "./coordinator";
export { CoordinatorClientView } from "./client-view";
export {
	CoordinatorExistsError,
	CoordinatorGoneError,
	ObserverMutationError,
	PaneNotFoundError,
} from "./errors";
export { directionalFocusTarget, normalizeSharedLayout } from "./focus-mapping";
export {
	assertValidCoordinatorId,
	coordinatorDir,
	coordinatorRecordFile,
	isValidCoordinatorId,
	multipaneRootDir,
	NATIVE_MULTIPANE_DIR_ENV,
	paneSessionId,
} from "./paths";
export {
	listCoordinatorIds,
	NATIVE_MULTIPANE_SCHEMA_VERSION,
	parseMultipaneRecord,
	readMultipaneRecord,
	recordLayout,
	removeMultipaneRecord,
	serializeMultipaneRecord,
	writeMultipaneRecordAtomic,
	type MultipanePaneEntry,
	type NativeMultipaneRecord,
} from "./record";
