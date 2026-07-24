/**
 * Native terminal diagnostics (seq 1258) — a read-only, native-specific snapshot
 * + formatter. Pure; no product caller yet (a prerequisite of HOST-009). See
 * snapshot.ts for the injected-data contract and redaction guarantees.
 */

export {
	buildDiagnosticsSnapshot,
	DIAGNOSTICS_STALE_AFTER_MS,
	NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA,
	NATIVE_TERMINAL_DIAGNOSTICS_VERSION,
	type DiagnosticFact,
	type DiagnosticsClientRole,
	type DiagnosticsLifecycle,
	type DiagnosticsLiveInput,
	type DiagnosticsQueueCounters,
	type DiagnosticsRecordInput,
	type DiagnosticsSnapshotCounters,
	type DiagnosticsVerdict,
	type NativeTerminalDiagnosticsInput,
	type NativeTerminalDiagnosticsSnapshot,
	type ParserHealth,
	type ParserQueueCountersInput,
	type ParserSnapshotCountersInput,
} from "./snapshot";
export { formatDiagnosticsSnapshot } from "./format";
