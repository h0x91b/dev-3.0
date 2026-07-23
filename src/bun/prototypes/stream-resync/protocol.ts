/**
 * Sequence model for the stream-resync spike (see ./README.md).
 *
 * Backend-neutral: frames carry opaque terminal ops. A host emits monotonically
 * numbered deltas and, on request, one snapshot capturing state at a base seq.
 * Pure module — no Bun/Node runtime deps, trivially unit-testable.
 */

export const RESYNC_PROTOCOL_VERSION = 1;

export interface OutputOp {
	kind: "output";
	data: Uint8Array;
}
export interface ResizeOp {
	kind: "resize";
	cols: number;
	rows: number;
}
export type StreamOp = OutputOp | ResizeOp;

/** Incremental output; `seq` is strictly increasing and 1-based. */
export interface DeltaFrame {
	v: number;
	type: "delta";
	seq: number;
	op: StreamOp;
}

/** Full state at `baseSeq`; the client resumes with deltas whose seq > baseSeq. */
export interface SnapshotFrame<S = unknown> {
	v: number;
	type: "snapshot";
	baseSeq: number;
	state: S;
}

export type HostFrame<S = unknown> = DeltaFrame | SnapshotFrame<S>;

export function outputDelta(seq: number, data: Uint8Array): DeltaFrame {
	return { v: RESYNC_PROTOCOL_VERSION, type: "delta", seq, op: { kind: "output", data } };
}
export function resizeDelta(seq: number, cols: number, rows: number): DeltaFrame {
	return { v: RESYNC_PROTOCOL_VERSION, type: "delta", seq, op: { kind: "resize", cols, rows } };
}
export function snapshotFrame<S>(baseSeq: number, state: S): SnapshotFrame<S> {
	return { v: RESYNC_PROTOCOL_VERSION, type: "snapshot", baseSeq, state };
}

/** Cost a frame charges against the client's bounded resync queue. */
export function deltaByteSize(op: StreamOp): number {
	return op.kind === "output" ? op.data.byteLength : 8;
}

export function isHostFrame(value: unknown): value is HostFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	if (frame.v !== RESYNC_PROTOCOL_VERSION) return false;
	if (frame.type === "delta") return typeof frame.seq === "number" && !!frame.op;
	if (frame.type === "snapshot") return typeof frame.baseSeq === "number";
	return false;
}
