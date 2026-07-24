/**
 * Native single-view terminal adapter (MIG-002 tracer, seq 1254).
 *
 * A cohesive, production-quality composition of the merged native primitives
 * into one single-view terminal lifecycle, driven by the existing backend-neutral
 * parity corpus. It has NO product callers yet (guarded by the isolation test)
 * and introduces no backend contract, selection, marker, flag, or fallback.
 *
 * See `README.md` for the adapter boundary and the exact gaps before MIG-002.
 */

export {
	NativeSingleViewAdapter,
	type CaptureOptions,
	type CleanupOptions,
	type CreateSessionOptions,
	type NativeAdapterDeps,
	type NativeSingleViewAdapterOptions,
	type SessionHandle,
	type SplitViewOptions,
	type ViewInfo,
} from "./adapter";
export {
	MultiViewUnsupportedError,
	NativeAdapterError,
	NativeSessionNotFoundError,
	NativeViewGoneError,
	type NativeAdapterErrorCode,
} from "./errors";
export {
	MonotonicSnapshotView,
	renderSnapshotText,
	type SnapshotReader,
} from "./view-reconstruction";
export {
	DEFAULT_RESYNC_BOUNDS,
	StreamResyncReader,
	deltaByteSize,
	type DeltaFrame,
	type ResyncBounds,
	type ResyncSink,
	type ResyncStatus,
	type SnapshotFrame,
	type StreamOp,
} from "./stream-resync";
export {
	createNativeParityHarness,
	detectNativeRuntime,
	type NativeParityHarness,
} from "./native-runner";
export {
	NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS,
	NATIVE_GAP_SCENARIOS,
	NATIVE_PURE_SCENARIOS,
	NATIVE_SINGLE_VIEW_LIVE_SCENARIOS,
} from "./scenario-partition";
