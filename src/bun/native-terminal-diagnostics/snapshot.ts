/**
 * Read-only diagnostic snapshot for one native terminal session (seq 1258, a
 * prerequisite of HOST-009 on the tmux-removal roadmap).
 *
 * This is a PURE module with NO product caller: it neither reads nor mutates the
 * registry, host, adapter, protocol, or parser. A future CLI/UI surface gathers
 * the facts from existing public read APIs (`registry.status()` → record + live
 * StatusReply + ownership verdict, the parser queue getters, and a parser-state
 * snapshot) and hands them here as plain injected data. `buildDiagnosticsSnapshot`
 * shapes that into a versioned, JSON-safe structure; `formatDiagnosticsSnapshot`
 * (format.ts) renders it for humans.
 *
 * REDACTION IS STRUCTURAL (allowlist). The builder only ever reads the explicit
 * set of fields below — session/view ids, versions, PIDs, lifecycle, writer
 * presence, timestamps, and bounded counters. It NEVER touches the endpoint,
 * bearer token, host executable, process start signatures, shell command line,
 * environment, or any parsed terminal output/screen. Anything a caller places in
 * an ignored field cannot reach the snapshot, which is what the redaction tests
 * prove.
 *
 * DETERMINISM. The snapshot is assembled in a fixed key order and reads named
 * fields, so the serialized output is independent of input property ordering.
 * The clock (`now`) and `lastAttachAt` are injected — the module never calls
 * Date.now / new Date — so snapshots are reproducible and staleness math is pure.
 *
 * STANDALONE BY CONTRACT. This module imports NOTHING from the host subsystem: it
 * declares its own plain input types, deliberately shaped to be structurally
 * compatible with the registry's public read APIs (record / status reply /
 * ownership verdict) so a future caller can pass those values straight through
 * without this module ever referencing them. That isolation is enforced (the
 * registry's own import-graph test forbids any outside reference to it).
 */

export const NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA = "dev3-native-terminal-diagnostics" as const;
export const NATIVE_TERMINAL_DIAGNOSTICS_VERSION = 1 as const;

/** Default age past which the parser-state heartbeat is reported as stale. */
export const DIAGNOSTICS_STALE_AFTER_MS = 15_000;

/** A fact is either KNOWN with a value, or explicitly UNKNOWN with a reason. */
export type DiagnosticFact<T> = { known: true; value: T } | { known: false; reason: string };

export type DiagnosticsLifecycle = "running" | "exited" | "reused" | "dead";
export type ParserHealth = "live" | "overflowed" | "failed";
/** Structurally matches the registry's `ClientRole`. */
export type DiagnosticsClientRole = "writer" | "observer";
/** Structurally matches the registry's `OwnershipVerdict`. */
export type DiagnosticsVerdict = "owned" | "reused" | "dead";

// ── Injected input (plain data mapped from public read APIs) ───────────────

/**
 * The persistent-record facts. Field names/types mirror `NativeSessionRecord` so
 * a caller can pass a record directly; every field is optional here because a
 * capture may have no record at all.
 */
export interface DiagnosticsRecordInput {
	sessionId?: string;
	paneId?: string;
	protocolVersion?: number;
	runtimeVersion?: string;
	hostArtifactVersion?: string;
	platform?: string;
	host?: { pid?: number };
	shell?: { pid?: number };
	createdAt?: string;
	updatedAt?: string;
}

/** The live status facts. Field names/types mirror the registry's `StatusReply`. */
export interface DiagnosticsLiveInput {
	sessionId?: string;
	paneId?: string;
	hostPid?: number;
	shellPid?: number;
	alive?: boolean;
	startedAt?: string;
	clientRole?: DiagnosticsClientRole;
	writerAttached?: boolean;
}

/** Queue counters the caller reads from `ParserEventQueue` getters. */
export interface ParserQueueCountersInput {
	pendingBytes: number;
	pendingEvents: number;
	lastSeq: number;
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
}

/**
 * Parser-state counters the caller maps from a `ParserStateSnapshot`. The parsed
 * screen (`state`) is deliberately absent — output must never enter diagnostics.
 */
export interface ParserSnapshotCountersInput {
	updatedAt: string;
	watermarkSeq: number;
	health: ParserHealth;
	frames: number;
	bytes: number;
	resizes: number;
	replies: number;
}

export interface NativeTerminalDiagnosticsInput {
	/** Injected ISO clock — determinism + staleness math; never read from the OS. */
	now: string;
	record?: DiagnosticsRecordInput | null;
	live?: DiagnosticsLiveInput | null;
	verdict?: DiagnosticsVerdict | null;
	/** Present only when the caller tracks it; otherwise reported unknown. */
	lastAttachAt?: string | null;
	queue?: ParserQueueCountersInput | null;
	snapshot?: ParserSnapshotCountersInput | null;
	/** Override the staleness threshold; defaults to DIAGNOSTICS_STALE_AFTER_MS. */
	staleAfterMs?: number;
}

// ── Snapshot output ────────────────────────────────────────────────────────

export interface DiagnosticsQueueCounters {
	pendingBytes: number;
	pendingEvents: number;
	lastSeq: number;
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
	overflowed: boolean;
}

export interface DiagnosticsSnapshotCounters {
	updatedAt: string;
	ageMs: number;
	watermarkSeq: number;
	health: ParserHealth;
	frames: number;
	bytes: number;
	resizes: number;
	replies: number;
}

export interface NativeTerminalDiagnosticsSnapshot {
	schema: typeof NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA;
	version: typeof NATIVE_TERMINAL_DIAGNOSTICS_VERSION;
	capturedAt: string;
	lifecycle: DiagnosticFact<DiagnosticsLifecycle>;
	freshness: DiagnosticFact<{ ageMs: number; stale: boolean }>;
	identity: {
		sessionId: DiagnosticFact<string>;
		viewId: DiagnosticFact<string>;
		protocolVersion: DiagnosticFact<number>;
		runtimeVersion: DiagnosticFact<string>;
		hostArtifactVersion: DiagnosticFact<string>;
		platform: DiagnosticFact<string>;
	};
	process: {
		hostPid: DiagnosticFact<number>;
		shellPid: DiagnosticFact<number>;
	};
	writer: {
		present: DiagnosticFact<boolean>;
		role: DiagnosticFact<DiagnosticsClientRole>;
	};
	timing: {
		createdAt: DiagnosticFact<string>;
		updatedAt: DiagnosticFact<string>;
		shellStartedAt: DiagnosticFact<string>;
		lastAttachAt: DiagnosticFact<string>;
	};
	counters: {
		queue: DiagnosticFact<DiagnosticsQueueCounters>;
		parserSnapshot: DiagnosticFact<DiagnosticsSnapshotCounters>;
	};
}

// ── Fact helpers ─────────────────────────────────────────────────────────────

function known<T>(value: T): DiagnosticFact<T> {
	return { known: true, value };
}

function unknown<T>(reason: string): DiagnosticFact<T> {
	return { known: false, reason };
}

/** A non-empty string, else unknown. */
function stringFact(value: unknown, reason: string): DiagnosticFact<string> {
	return typeof value === "string" && value.length > 0 ? known(value) : unknown(reason);
}

/** A finite non-negative integer (PID / version), else unknown. */
function positiveIntFact(value: unknown, reason: string): DiagnosticFact<number> {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? known(value) : unknown(reason);
}

function protocolVersionFact(value: unknown, reason: string): DiagnosticFact<number> {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? known(value) : unknown(reason);
}

/** True only for a finite non-negative number — the boundedness guard for counters. */
function isBoundedCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ── Derivations ──────────────────────────────────────────────────────────────

function deriveLifecycle(input: NativeTerminalDiagnosticsInput): DiagnosticFact<DiagnosticsLifecycle> {
	const verdict = input.verdict ?? null;
	if (verdict === "dead") return known("dead");
	if (verdict === "reused") return known("reused");
	if (verdict === "owned") {
		return input.live && input.live.alive === false ? known("exited") : known("running");
	}
	if (input.live) return input.live.alive ? known("running") : known("exited");
	return unknown("no ownership verdict or live status provided");
}

function deriveFreshness(input: NativeTerminalDiagnosticsInput): DiagnosticFact<{ ageMs: number; stale: boolean }> {
	const observedAt = input.snapshot?.updatedAt;
	if (typeof observedAt !== "string" || observedAt.length === 0) {
		return unknown("no parser-state snapshot to measure freshness against");
	}
	const nowMs = Date.parse(input.now);
	const observedMs = Date.parse(observedAt);
	if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs)) {
		return unknown("captured-at or parser-state timestamp is unparseable");
	}
	const ageMs = Math.max(0, nowMs - observedMs);
	const threshold = typeof input.staleAfterMs === "number" ? input.staleAfterMs : DIAGNOSTICS_STALE_AFTER_MS;
	return known({ ageMs, stale: ageMs > threshold });
}

function deriveWriterPresence(live: DiagnosticsLiveInput | null | undefined): DiagnosticFact<boolean> {
	if (!live) return unknown("writer presence is only reported by a live status reply");
	if (typeof live.writerAttached !== "boolean") return unknown("live status reply predates writer ownership");
	return known(live.writerAttached);
}

function deriveWriterRole(live: DiagnosticsLiveInput | null | undefined): DiagnosticFact<DiagnosticsClientRole> {
	if (!live) return unknown("writer role is only reported by a live status reply");
	if (live.clientRole !== "writer" && live.clientRole !== "observer") {
		return unknown("live status reply carried no client role");
	}
	return known(live.clientRole);
}

function deriveQueueCounters(
	queue: ParserQueueCountersInput | null | undefined,
): DiagnosticFact<DiagnosticsQueueCounters> {
	if (!queue) return unknown("no parser queue counters provided");
	const fields = [queue.pendingBytes, queue.pendingEvents, queue.lastSeq, queue.droppedChunks, queue.droppedBytes, queue.droppedResizes];
	if (!fields.every(isBoundedCount)) {
		return unknown("parser queue counters contained a non-finite or negative value");
	}
	return known({
		pendingBytes: queue.pendingBytes,
		pendingEvents: queue.pendingEvents,
		lastSeq: queue.lastSeq,
		droppedChunks: queue.droppedChunks,
		droppedBytes: queue.droppedBytes,
		droppedResizes: queue.droppedResizes,
		overflowed: queue.droppedChunks > 0 || queue.droppedResizes > 0,
	});
}

function deriveSnapshotCounters(
	snapshot: ParserSnapshotCountersInput | null | undefined,
	nowIso: string,
): DiagnosticFact<DiagnosticsSnapshotCounters> {
	if (!snapshot) return unknown("no parser-state snapshot provided");
	if (snapshot.health !== "live" && snapshot.health !== "overflowed" && snapshot.health !== "failed") {
		return unknown("parser-state snapshot carried an unknown health status");
	}
	const fields = [snapshot.watermarkSeq, snapshot.frames, snapshot.bytes, snapshot.resizes, snapshot.replies];
	if (!fields.every(isBoundedCount)) {
		return unknown("parser-state counters contained a non-finite or negative value");
	}
	if (typeof snapshot.updatedAt !== "string" || snapshot.updatedAt.length === 0) {
		return unknown("parser-state snapshot had no updated-at timestamp");
	}
	const nowMs = Date.parse(nowIso);
	const updatedMs = Date.parse(snapshot.updatedAt);
	const ageMs = Number.isFinite(nowMs) && Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : 0;
	return known({
		updatedAt: snapshot.updatedAt,
		ageMs,
		watermarkSeq: snapshot.watermarkSeq,
		health: snapshot.health,
		frames: snapshot.frames,
		bytes: snapshot.bytes,
		resizes: snapshot.resizes,
		replies: snapshot.replies,
	});
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the versioned, JSON-safe diagnostic snapshot from injected data. Missing
 * facts become explicit `unknown` with a reason; present facts are validated and
 * bounded. Fixed key order guarantees deterministic serialization.
 */
export function buildDiagnosticsSnapshot(input: NativeTerminalDiagnosticsInput): NativeTerminalDiagnosticsSnapshot {
	const record = input.record ?? null;
	const live = input.live ?? null;

	return {
		schema: NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA,
		version: NATIVE_TERMINAL_DIAGNOSTICS_VERSION,
		capturedAt: input.now,
		lifecycle: deriveLifecycle(input),
		freshness: deriveFreshness(input),
		identity: {
			sessionId: stringFact(record?.sessionId ?? live?.sessionId, "session id not present in record or live status"),
			viewId: stringFact(record?.paneId ?? live?.paneId, "view id not present in record or live status"),
			protocolVersion: protocolVersionFact(record?.protocolVersion, "protocol version is only known from the registry record"),
			runtimeVersion: stringFact(record?.runtimeVersion, "runtime version is only known from the registry record"),
			hostArtifactVersion: stringFact(record?.hostArtifactVersion, "host artifact version is only known from the registry record"),
			platform: stringFact(record?.platform, "platform is only known from the registry record"),
		},
		process: {
			hostPid: positiveIntFact(record?.host?.pid ?? live?.hostPid, "host pid not present in record or live status"),
			shellPid: positiveIntFact(record?.shell?.pid ?? live?.shellPid, "shell pid not present in record or live status"),
		},
		writer: {
			present: deriveWriterPresence(live),
			role: deriveWriterRole(live),
		},
		timing: {
			createdAt: stringFact(record?.createdAt, "created-at is only known from the registry record"),
			updatedAt: stringFact(record?.updatedAt, "updated-at is only known from the registry record"),
			shellStartedAt: stringFact(live?.startedAt, "shell start time is only reported by a live status reply"),
			lastAttachAt: stringFact(input.lastAttachAt, "last-attach time is not tracked by the registry record or status reply"),
		},
		counters: {
			queue: deriveQueueCounters(input.queue),
			parserSnapshot: deriveSnapshotCounters(input.snapshot, input.now),
		},
	};
}
