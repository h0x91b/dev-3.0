/**
 * The native multi-pane terminal session coordinator (seq 1283, LAY-003/004/005).
 *
 * COMPOSITION, NOT A NEW DAEMON: one logical pane === one existing
 * registry-owned PTY host. The coordinator binds stable logical pane ids to
 * those hosts, owns the shared `SplitTree`, and persists a minimal versioned
 * record, so a fresh controller after an app-process restart rediscovers the
 * same panes, hosts, and shells without spawning or attaching twice. Protocol v1
 * stays a single-PTY contract (decision 169).
 *
 * THREE DISTINCT LAYERS, kept apart on purpose:
 *  • shared    — pane membership + geometry (`SplitTree`), persisted here;
 *  • per client— focus and zoom (`CoordinatorClientView`), never persisted;
 *  • per PTY   — cols/rows, owned by whichever client the host made writer.
 *
 * Never inspects, attaches to, migrates, stops, or modifies a tmux session, and
 * has no product caller: it is composed by its own harness and tests only.
 */

import { listPaneIds, restoreSplitTree, serializeSplitTree, splitPane, closePane as closeTreePane, createSplitTree, validateSplitTree, type SplitOrientation, type SplitTree } from "../../shared/split-tree";
import { existsSync } from "node:fs";
import { withFileLock } from "../file-lock";
import { NativeSessionClient } from "../native-terminal-registry/client";
import { classifyOwnership, type OwnershipVerdict } from "../native-terminal-registry/ownership";
import type { ClientRole } from "../native-terminal-registry/writer-ownership";
import {
	captureProducerDigest,
	inspectCaptureRecord,
	type CaptureRecord,
	type CaptureProducer,
	type CaptureRecordInspection,
} from "../native-terminal-registry/capture-record";
import {
	inspectRecordFile,
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
	readRecord,
	readToken,
	type NativeSessionRecord,
	type RecordInspection,
} from "../native-terminal-registry/record";
import { start, stop, type StartOptions, type StartResult } from "../native-terminal-registry/registry";
import type { ShellLaunchSpec } from "../native-terminal-registry/shell-launch";
import { CoordinatorClientView } from "./client-view";
import type { NativeSemanticState } from "../native-terminal-registry/ghostty-live";
import { parserStateFile } from "../native-terminal-registry/paths";
import { readParserState, type ParserStateSnapshot } from "../native-terminal-registry/parser-state";
import {
	CoordinatorExistsError,
	CoordinatorGoneError,
	LayoutPaneSetMismatchError,
	ObserverMutationError,
	PaneNotFoundError,
	PaneResizeNotAppliedError,
} from "./errors";
import { normalizeSharedLayout } from "./focus-mapping";
import { coordinatorRecordFile, paneSessionId } from "./paths";
import {
	NATIVE_MULTIPANE_SCHEMA_VERSION,
	pruneCoordinatorDir,
	readMultipaneRecord,
	readMultipaneRecordStrict,
	removeMultipaneRecord,
	writeMultipaneRecordAtomic,
	type MultipanePaneEntry,
	type NativeMultipaneRecord,
} from "./record";

const RECORD_LOCK_TIMEOUT_MS = 30_000;
const RESIZE_APPLY_TIMEOUT_MS = 5000;

/** Everything a genuinely independent pane shell needs — no implicit inheritance. */
export interface PaneLaunchSpec {
	launch: ShellLaunchSpec;
	cols?: number;
	rows?: number;
	timeoutMs?: number;
}

export interface PaneSnapshot {
	paneId: string;
	sessionId: string;
	hostPid: number;
	shellPid: number;
	/**
	 * The host's and shell's start signatures — the same evidence ownership
	 * classification uses. A pid alone cannot identify a process incarnation,
	 * because the OS reuses pids; the signature pins the actual start. Empty
	 * strings for a dead pane, whose record is already gone.
	 */
	hostStartSignature: string;
	shellStartSignature: string;
	cols: number;
	rows: number;
	state: "running" | "reused" | "dead";
	/** True when the host advertises a capture surface. */
	publishesScreen: boolean;
}

/**
 * One recovery sweep's full result: the reconciled controller PLUS the pane
 * snapshots proved by that very sweep. Recovering and then calling
 * {@link NativeMultipaneCoordinator.listPanes} classifies the same pane set
 * twice — two `ps` probes per pane, per pass (seq 1388).
 */
export interface RecoveredPaneSet {
	coordinator: NativeMultipaneCoordinator;
	panes: PaneSnapshot[];
}

export interface CloseResult {
	closedPaneId: string;
	remainingPaneIds: string[];
	/** True when the closed pane was the last one and the logical session ended. */
	sessionTornDown: boolean;
}

/** A live attachment to one pane's host, narrowed to what the coordinator needs. */
export interface PaneConnection {
	role(): ClientRole | null;
	onOutput(cb: (bytes: Uint8Array) => void): () => void;
	input(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	/**
	 * Fires when the underlying socket has actually closed. `close()` drops the role
	 * synchronously, long before the socket is really gone, so role state alone cannot
	 * tell a real disconnect from a socket that never closed (seq 1407).
	 */
	onDisconnect(cb: () => void): void;
	close(): void;
}

/**
 * How a pane's parser-state file reads. Told apart because "the file is not
 * there" and "the file is there and cannot be believed" are different answers,
 * and `readParserState` collapses both into `null`.
 */
export type ParserStateInspection =
	| { kind: "present"; snapshot: ParserStateSnapshot }
	| { kind: "rejected"; problem: string }
	| { kind: "absent" };

/** Where a read-only capture of one pane can source its text, or why it cannot. */
export type PaneCaptureSource =
	/** The compact plain-text projection — the cheap surface. */
	| { kind: "capture-record"; record: CaptureRecord }
	| { kind: "snapshot"; snapshot: ParserStateSnapshot; state: NativeSemanticState }
	/** Capturable, nothing observed yet. */
	| { kind: "empty"; reason: string }
	/** The host publishes no screen at all — a configuration fact, not a failure. */
	| { kind: "disabled"; reason: string }
	| { kind: "unreadable"; reason: string };

/** The producer identity a pane's record currently names. */
function producerOf(record: NativeSessionRecord): CaptureProducer {
	return {
		hostPid: record.host.pid,
		hostStartSignature: record.host.startSignature,
		shellPid: record.shell.pid,
		shellStartSignature: record.shell.startSignature,
	};
}

function inspectParserStateFile(sessionId: string): ParserStateInspection {
	if (!existsSync(parserStateFile(sessionId))) return { kind: "absent" };
	const snapshot = readParserState(sessionId);
	if (snapshot) return { kind: "present", snapshot };
	return { kind: "rejected", problem: "schema, version, parser identity, or session id did not match" };
}

/** Injected effects, so the coordinator is unit-testable without real processes. */
export interface CoordinatorDeps {
	startPane(sessionId: string, opts: StartOptions): Promise<StartResult>;
	stopPane(sessionId: string, opts?: { timeoutMs?: number }): Promise<boolean>;
	readPaneRecord(sessionId: string): NativeSessionRecord | null;
	/**
	 * Why a record was rejected, for the one decision that needs it: telling a
	 * record that is gone from one that is there but unreadable. Optional so an
	 * in-memory double need not model file problems.
	 */
	inspectPaneRecord?(sessionId: string): RecordInspection;
	readPaneToken(sessionId: string): string | null;
	/**
	 * How the pane's parser snapshot reads — the read-only capture source. Optional
	 * so an in-memory double need not model the file; it then falls back to the
	 * real on-disk inspection, which simply reports `absent`.
	 */
	inspectPaneParserState?(sessionId: string): ParserStateInspection;
	/**
	 * How the compact capture artifact reads, for a host advertising that surface.
	 * Optional so an in-memory double need not model the file.
	 */
	inspectPaneCaptureRecord?(sessionId: string, producerDigest: string): CaptureRecordInspection;
	classifyPane(record: NativeSessionRecord, token: string | null): Promise<OwnershipVerdict>;
	connectPane(record: NativeSessionRecord, token: string): Promise<PaneConnection>;
}

export const defaultCoordinatorDeps: CoordinatorDeps = {
	startPane: (sessionId, opts) => start(sessionId, opts),
	stopPane: (sessionId, opts) => stop(sessionId, opts ?? {}),
	readPaneRecord: readRecord,
	inspectPaneRecord: inspectRecordFile,
	readPaneToken: readToken,
	inspectPaneParserState: inspectParserStateFile,
	inspectPaneCaptureRecord: inspectCaptureRecord,
	classifyPane: classifyOwnership,
	async connectPane(record, token) {
		const client = new NativeSessionClient();
		await client.connect(record, token, { timeoutMs: 5000 });
		return {
			role: () => client.getRole(),
			onOutput: (cb) => client.onOutput(cb),
			input: (data) => client.input(data),
			resize: (cols, rows) => client.resize(cols, rows),
			onDisconnect: (cb) => client.onDisconnect(cb),
			close: () => client.close(),
		};
	},
};

function nowIso(): string {
	return new Date().toISOString();
}

function buildRecord(
	coordinatorId: string,
	epoch: string,
	tree: SplitTree,
	panes: MultipanePaneEntry[],
): NativeMultipaneRecord {
	return {
		schemaVersion: NATIVE_MULTIPANE_SCHEMA_VERSION,
		coordinatorId,
		epoch,
		updatedAt: nowIso(),
		layout: serializeSplitTree(tree),
		panes,
	};
}

/** Bindings in shared layout order, so the record is self-consistent by construction. */
function bindPanes(coordinatorId: string, tree: SplitTree): MultipanePaneEntry[] {
	return listPaneIds(tree).map((paneId) => ({ paneId, sessionId: paneSessionId(coordinatorId, paneId) }));
}

export class NativeMultipaneCoordinator {
	private tree: SplitTree;
	private readonly connections = new Map<string, PaneConnection>();
	private torndown = false;

	private constructor(
		readonly coordinatorId: string,
		readonly epoch: string,
		tree: SplitTree,
		private readonly deps: CoordinatorDeps,
	) {
		this.tree = tree;
	}

	/**
	 * Create a brand-new logical session with one pane. Refuses when a live
	 * coordinator already holds the id, so a second controller can never
	 * double-spawn over an existing pane set.
	 */
	static async create(
		coordinatorId: string,
		spec: PaneLaunchSpec,
		deps: CoordinatorDeps = defaultCoordinatorDeps,
	): Promise<NativeMultipaneCoordinator> {
		return withFileLock(
			coordinatorRecordFile(coordinatorId),
			async () => {
				// Strict, because creation is the most destructive path there is: it starts a
				// pane and overwrites the coordinator file. Only a genuinely ABSENT record
				// may be created over. State that is present and cannot be believed — corrupt,
				// or bound to another coordinator — throws here, before any start or write,
				// instead of being read as "nothing exists" and orphaning live processes.
				const existing = readMultipaneRecordStrict(coordinatorId);
				if (existing) {
					if (await hasLivePane(existing, deps)) throw new CoordinatorExistsError(coordinatorId);
					await dropPanes(existing.panes, deps);
					removeMultipaneRecord(coordinatorId, existing.epoch);
				}
				const tree = normalizeSharedLayout(createSplitTree());
				const panes = bindPanes(coordinatorId, tree);
				await deps.startPane(panes[0]!.sessionId, {
					launch: spec.launch,
					cols: spec.cols,
					rows: spec.rows,
					timeoutMs: spec.timeoutMs,
				});
				const epoch = nowIso();
				writeMultipaneRecordAtomic(buildRecord(coordinatorId, epoch, tree, panes));
				return new NativeMultipaneCoordinator(coordinatorId, epoch, tree, deps);
			},
			{ timeout: RECORD_LOCK_TIMEOUT_MS, staleThreshold: RECORD_LOCK_TIMEOUT_MS * 2 },
		);
	}

	/**
	 * Rediscover an existing logical session from disk — the fresh-controller
	 * path after an app-process restart. Never spawns a shell. Panes whose host
	 * no longer verifies as ours are reconciled out of the layout deterministically;
	 * when none survive the coordinator is gone and null is returned.
	 */
	static async recover(
		coordinatorId: string,
		deps: CoordinatorDeps = defaultCoordinatorDeps,
	): Promise<NativeMultipaneCoordinator | null> {
		return (await NativeMultipaneCoordinator.recoverPaneSet(coordinatorId, deps))?.coordinator ?? null;
	}

	/**
	 * {@link recover}, keeping the snapshots the recovery sweep already proved.
	 * Reconciliation is unchanged — it is the same verdicts, read once instead of
	 * twice, so the returned snapshots and the returned layout describe the same
	 * instant rather than two consecutive `ps` passes.
	 */
	/**
	 * Read the pane set WITHOUT reconciling anything: same probes as recovery, none
	 * of its consequences. No pane is stopped, no record is written, no layout is
	 * republished, and a coordinator record is never removed. Panes whose ownership
	 * is disproven or unknown are REPORTED as evidence instead of being swept —
	 * because an observation that mutates runtime or persisted membership is not an
	 * observation.
	 */
	static async inspectPaneSet(
		coordinatorId: string,
		deps: CoordinatorDeps = defaultCoordinatorDeps,
	): Promise<{ epoch: string; panes: PaneSnapshot[]; layout: SplitTree } | null> {
		const record = readMultipaneRecord(coordinatorId);
		if (!record) return null;
		const tree = restoreSplitTree(record.layout);
		if (!tree) return null;
		const probes = await Promise.all(record.panes.map((pane) => probePane(pane, deps)));
		return { epoch: record.epoch, panes: probes.map(snapshotOf), layout: tree };
	}

	static async recoverPaneSet(
		coordinatorId: string,
		deps: CoordinatorDeps = defaultCoordinatorDeps,
		opts: { strict?: boolean } = {},
	): Promise<RecoveredPaneSet | null> {
		return withFileLock(
			coordinatorRecordFile(coordinatorId),
			async () => {
				// A strict caller must not have "no record" invented for it: a coordinator
				// file that exists but cannot be parsed means the pane set is unknown.
				const record = opts.strict === true
					? readMultipaneRecordStrict(coordinatorId)
					: readMultipaneRecord(coordinatorId);
				if (!record) return null;
				const tree = restoreSplitTree(record.layout);
				if (!tree) return null;

				// One classification per pane, all in flight at once: each probe shells out
				// to `ps`, so doing them in sequence made recovery cost grow linearly with
				// the pane count on the click path (seq 1382).
				const probes = await Promise.all(record.panes.map((pane) => probePane(pane, deps)));
				// A pane whose own record we cannot read is not proof of death: its shell
				// may still be running, and `stop()` reports success for a record it
				// cannot read without ever signalling the pid. So the EVIDENCE that such
				// a pane exists must outlive every read, tolerant ones included — a
				// renderer poll that swept it out of the record would answer a later
				// strict question by having deleted the answer.
				const unknown = probes.filter((probe) => probe.ownershipUnknown);
				if (opts.strict === true && unknown.length > 0) {
					// Refuse BEFORE mutating anything: no drop, no rewrite, no membership
					// change, so the caller sees the set exactly as it was found.
					throw new PaneOwnershipUnknownError(
						coordinatorId,
						unknown.map((probe) => probe.pane.paneId),
					);
				}
				// Only a pane whose death was actually established may be reconciled away.
				const dead = probes.filter((probe) => probe.verdict !== "owned" && !probe.ownershipUnknown);
				const hidden = unknown.length > 0;
				if (dead.length === 0 && !hidden) {
					return {
						coordinator: new NativeMultipaneCoordinator(coordinatorId, record.epoch, tree, deps),
						panes: probes.map(snapshotOf),
					};
				}
				if (dead.length === record.panes.length) {
					await dropPanes(record.panes, deps);
					removeMultipaneRecord(coordinatorId, record.epoch);
					return null;
				}
				let reconciled = tree;
				for (const probe of dead) reconciled = closeTreePane(reconciled, probe.pane.paneId);
				reconciled = normalizeSharedLayout(reconciled);
				await dropPanes(dead.map((probe) => probe.pane), deps);
				// An unknown-owner pane stays in the record and in the tree; it is only
				// HIDDEN from this snapshot, so the UI does not show a pane it cannot
				// describe while the evidence stays on disk for the next strict read.
				if (dead.length > 0) {
					writeMultipaneRecordAtomic(
						buildRecord(coordinatorId, record.epoch, reconciled, bindPanes(coordinatorId, reconciled)),
					);
				}
				// `reconciled` closes exactly the panes proved dead and keeps every
				// unknown-owner one, so it is the right tree in both cases — and it is the
				// tree just persisted. Handing back the PRE-sweep tree instead would let the
				// backend cache a dead pane and republish it under the same epoch.
				return {
					coordinator: new NativeMultipaneCoordinator(coordinatorId, record.epoch, reconciled, deps),
					// Survivors keep the record's order, which is the reconciled tree's order.
					panes: probes.filter((probe) => probe.verdict === "owned").map(snapshotOf),
				};
			},
			{ timeout: RECORD_LOCK_TIMEOUT_MS, staleThreshold: RECORD_LOCK_TIMEOUT_MS * 2 },
		);
	}

	/** The shared layout: membership + geometry, with no client overlay applied. */
	get layout(): SplitTree {
		return this.tree;
	}

	paneIds(): string[] {
		return listPaneIds(this.tree);
	}

	sessionIdFor(paneId: string): string {
		this.assertPane(paneId);
		return paneSessionId(this.coordinatorId, paneId);
	}

	/**
	 * Per-pane host/shell identity, read from each pane's own registry record.
	 * A caller that has just recovered already holds these — see
	 * {@link NativeMultipaneCoordinator.recoverPaneSet}; calling both classifies twice.
	 */
	async listPanes(): Promise<PaneSnapshot[]> {
		// Fan out over the pane set, bounded by the pane count: every snapshot needs
		// its own `ps` probe, and in sequence that dominated every pane action.
		return Promise.all(
			this.paneIds().map(async (paneId): Promise<PaneSnapshot> => {
				const pane = { paneId, sessionId: paneSessionId(this.coordinatorId, paneId) };
				return snapshotOf(await probePane(pane, this.deps));
			}),
		);
	}

	/**
	 * Split a pane, spawning a genuinely independent shell with its own explicit
	 * executable/argv/cwd/env behind a fresh stable logical pane id. The layout is
	 * published only after the new host reports readiness, so a failed spawn
	 * leaves the previous pane set intact.
	 */
	async split(paneId: string, orientation: SplitOrientation, spec: PaneLaunchSpec): Promise<string> {
		this.assertPane(paneId);
		return this.withOwnedRecord(async () => {
			const rawTree = splitPane(this.tree, paneId, orientation);
			const created = listPaneIds(rawTree).find((id) => !listPaneIds(this.tree).includes(id));
			if (!created) throw new PaneNotFoundError(paneId);
			await this.deps.startPane(paneSessionId(this.coordinatorId, created), {
				launch: spec.launch,
				cols: spec.cols,
				rows: spec.rows,
				timeoutMs: spec.timeoutMs,
			});
			// Activate the new pane in the shared layout (clear zoom; new pane is focused).
			this.publish({ ...rawTree, activePaneId: created, zoomedPaneId: null });
			return created;
		});
	}

	/**
	 * Close one pane: stop only its owned process tree, then reconcile the layout.
	 * Closing the final pane tears the logical session down instead.
	 */
	async closePane(paneId: string): Promise<CloseResult> {
		this.assertPane(paneId);
		if (this.paneIds().length === 1) {
			await this.cleanup();
			return { closedPaneId: paneId, remainingPaneIds: [], sessionTornDown: true };
		}
		return this.withOwnedRecord(async () => {
			this.dropConnection(paneId);
			await this.deps.stopPane(paneSessionId(this.coordinatorId, paneId));
			this.publish(normalizeSharedLayout(closeTreePane(this.tree, paneId)));
			return { closedPaneId: paneId, remainingPaneIds: this.paneIds(), sessionTornDown: false };
		});
	}

	/** Stop every owned pane tree and drop the record. Safe to call repeatedly. */
	async cleanup(): Promise<void> {
		if (this.torndown) return;
		this.torndown = true;
		for (const paneId of this.paneIds()) this.dropConnection(paneId);
		for (const paneId of this.paneIds()) {
			await this.deps.stopPane(paneSessionId(this.coordinatorId, paneId));
		}
		await withFileLock(
			coordinatorRecordFile(this.coordinatorId),
			async () => {
				removeMultipaneRecord(this.coordinatorId, this.epoch);
			},
			{ timeout: RECORD_LOCK_TIMEOUT_MS, staleThreshold: RECORD_LOCK_TIMEOUT_MS * 2 },
		);
		pruneCoordinatorDir(this.coordinatorId); // only possible once the lock dir is gone
	}

	/** Detach this controller's attachments; every pane process keeps running. */
	detach(): void {
		for (const paneId of [...this.connections.keys()]) this.dropConnection(paneId);
	}

	/** A new client view over the current shared pane set (focus/zoom stay local). */
	attachClient(viewId: string): CoordinatorClientView {
		return new CoordinatorClientView(viewId, this.paneIds());
	}

	/** Attach to one pane's host, reusing this controller's existing attachment. */
	async connect(paneId: string): Promise<PaneConnection> {
		this.assertPane(paneId);
		const cached = this.connections.get(paneId);
		if (cached) return cached;
		const sessionId = paneSessionId(this.coordinatorId, paneId);
		const record = this.deps.readPaneRecord(sessionId);
		const token = this.deps.readPaneToken(sessionId);
		if (!record || !token) throw new PaneNotFoundError(paneId);
		const connection = await this.deps.connectPane(record, token);
		this.connections.set(paneId, connection);
		return connection;
	}

	/**
	 * Writer-owned: an observer attachment is refused rather than silently
	 * ignored. Resolves only once the pane's host has republished the new size,
	 * so a caller that reads the record right after never sees the stale one.
	 */
	async resizePane(paneId: string, cols: number, rows: number, opts: { timeoutMs?: number } = {}): Promise<void> {
		const connection = await this.connect(paneId);
		if (connection.role() !== "writer") throw new ObserverMutationError(paneId, "resize");
		connection.resize(cols, rows);
		const sessionId = paneSessionId(this.coordinatorId, paneId);
		const deadline = Date.now() + (opts.timeoutMs ?? RESIZE_APPLY_TIMEOUT_MS);
		for (;;) {
			const record = this.deps.readPaneRecord(sessionId);
			if (record?.cols === cols && record.rows === rows) return;
			if (Date.now() >= deadline) {
				throw new PaneResizeNotAppliedError(paneId, cols, rows, record?.cols ?? -1, record?.rows ?? -1);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Writer-owned: observers may watch a pane but never type into it. */
	async writePane(paneId: string, data: string | Uint8Array): Promise<void> {
		const connection = await this.connect(paneId);
		if (connection.role() !== "writer") throw new ObserverMutationError(paneId, "input");
		connection.input(data);
	}

	/**
	 * The read-only capture source for one pane: the host's bounded
	 * parser snapshot, straight off disk.
	 *
	 * It deliberately does NOT connect. The host publishes `parser-state.json`
	 * whether or not any client is attached, so reading it takes no writer lease,
	 * sends no protocol message, and cannot disturb the pane — which is the whole
	 * point of a capture. A connect here would also make an idle observer
	 * establish a WebSocket just to read text.
	 *
	 * Every outcome is named, because "no snapshot" has three very different
	 * causes and a caller acts differently on each.
	 */
	readPaneCaptureSource(paneId: string): PaneCaptureSource {
		this.assertPane(paneId);
		return NativeMultipaneCoordinator.inspectPaneCaptureSource(this.coordinatorId, paneId, this.deps);
	}

	/**
	 * Read one pane's capture source WITHOUT a controller and without reconciling
	 * anything — the observational path a capture uses. Static because constructing
	 * a coordinator is a recovery, and a recovery is allowed to mutate.
	 */
	static inspectPaneCaptureSource(
		coordinatorId: string,
		paneId: string,
		deps: CoordinatorDeps = defaultCoordinatorDeps,
	): PaneCaptureSource {
		const sessionId = paneSessionId(coordinatorId, paneId);
		const record = deps.readPaneRecord(sessionId);
		if (!record) {
			return { kind: "unreadable", reason: "the pane's record could not be read" };
		}
		// The host SAYS which surfaces it publishes. An empty or absent list covers a
		// host launched without a parser and a host built before the field, and both
		// mean the same thing: there is nothing to capture for this pane, ever.
		const surfaces = record.capabilities?.capture ?? [];
		if (surfaces.length === 0) {
			return {
				kind: "disabled",
				reason: "this pane's host publishes no screen to capture (no live parser)",
			};
		}

		// Prefer the compact surface; fall back to the per-cell one.
		if (surfaces.includes(NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY)) {
			const inspect = deps.inspectPaneCaptureRecord ?? inspectCaptureRecord;
			// The reader derives the CURRENT producer's path from the session record, so a
			// dead producer's artifact is not merely rejected — it is never even addressed.
			const inspection = inspect(sessionId, captureProducerDigest(producerOf(record)));
			if (inspection.kind === "present") return { kind: "capture-record", record: inspection.record };
			if (inspection.kind === "rejected") {
				return { kind: "unreadable", reason: `the pane's capture record could not be believed: ${inspection.problem}` };
			}
			if (!surfaces.includes(NATIVE_SESSION_CAPTURE_CAPABILITY)) {
				return { kind: "empty", reason: "the pane's host has not published its first capture record yet" };
			}
		}

		const inspect = deps.inspectPaneParserState ?? inspectParserStateFile;
		const inspection = inspect(sessionId);
		if (inspection.kind === "rejected") {
			return {
				kind: "unreadable",
				reason: `the pane's parser snapshot could not be believed: ${inspection.problem}`,
			};
		}
		if (inspection.kind === "absent") {
			return { kind: "empty", reason: "the pane's parser has not published its first screen yet" };
		}
		const snapshot = inspection.snapshot;
		if (!snapshot.state) {
			const detail = snapshot.health.error ?? `parser is ${snapshot.health.status}`;
			return { kind: "empty", reason: `the pane's parser has published no screen yet (${detail})` };
		}
		return { kind: "snapshot", snapshot, state: snapshot.state };
	}

	/**
	 * Publish a geometry-only layout change: same pane set, new ratios/shape.
	 * Rejects when the new tree's pane id set differs from the current one (order
	 * differences also count as a mismatch — no silent reconciliation).
	 */
	async publishGeometry(tree: SplitTree): Promise<void> {
		const validation = validateSplitTree(tree);
		if (!validation.valid) {
			throw new Error(`invalid SplitTree: ${validation.errors.join("; ")}`);
		}
		const newIds = listPaneIds(tree);
		const currentIds = this.paneIds();
		if (
			newIds.length !== currentIds.length ||
			newIds.some((id, i) => currentIds[i] !== id)
		) {
			throw new LayoutPaneSetMismatchError(this.coordinatorId, currentIds, newIds);
		}
		return this.withOwnedRecord(async () => {
			// Zoom rides along with the geometry: the toolbar drives zoom through this
			// path, so clearing it here would make the Zoom button a silent no-op.
			this.publish({ ...tree });
		});
	}

	private assertPane(paneId: string): void {
		if (!this.paneIds().includes(paneId)) throw new PaneNotFoundError(paneId);
	}

	private dropConnection(paneId: string): void {
		const connection = this.connections.get(paneId);
		if (!connection) return;
		this.connections.delete(paneId);
		try {
			connection.close();
		} catch {
			// already closed — detaching must never fail a lifecycle operation
		}
	}

	/** Serialise a layout mutation and verify we still own the record epoch. */
	private async withOwnedRecord<T>(mutate: () => Promise<T>): Promise<T> {
		return withFileLock(
			coordinatorRecordFile(this.coordinatorId),
			async () => {
				const current = readMultipaneRecord(this.coordinatorId);
				if (!current || current.epoch !== this.epoch) throw new CoordinatorGoneError(this.coordinatorId);
				return mutate();
			},
			{ timeout: RECORD_LOCK_TIMEOUT_MS, staleThreshold: RECORD_LOCK_TIMEOUT_MS * 2 },
		);
	}

	private publish(tree: SplitTree): void {
		this.tree = tree;
		writeMultipaneRecordAtomic(
			buildRecord(this.coordinatorId, this.epoch, tree, bindPanes(this.coordinatorId, tree)),
		);
	}
}

/**
 * A pane's own record could not be read, so whether its process is still running is
 * unknown. Thrown only by a STRICT recovery, and thrown before the sweep changes
 * anything, so the caller sees the set exactly as it found it.
 */
export class PaneOwnershipUnknownError extends Error {
	constructor(readonly coordinatorId: string, readonly paneIds: string[]) {
		super(
			`the record of pane ${paneIds.join(", ")} in ${coordinatorId} is missing or unreadable, `
			+ "so whether its process is still running cannot be determined",
		);
		this.name = "PaneOwnershipUnknownError";
	}
}

/** One pane's record plus its ownership verdict — the single unit of a sweep. */
interface PaneProbe {
	pane: MultipanePaneEntry;
	record: NativeSessionRecord | null;
	verdict: OwnershipVerdict;
	/**
	 * There IS something where this pane's record should be, and it cannot be
	 * believed — unparseable, a foreign schema, or claiming another pane's identity.
	 * So the pane is neither owned nor provably dead.
	 */
	ownershipUnknown: boolean;
}

async function probePane(pane: MultipanePaneEntry, deps: CoordinatorDeps): Promise<PaneProbe> {
	const record = deps.readPaneRecord(pane.sessionId);
	// A record that is GONE is proof enough: a stopped pane takes its record with it,
	// so there is nothing left to verify against and the pane is swept as before.
	// A record that is PRESENT but unreadable is a different animal — the shell it
	// described may still be running and `stop()` would report success without ever
	// signalling the pid, so its ownership is unknown rather than dead.
	if (!record) {
		return { pane, record: null, verdict: "dead", ownershipUnknown: paneRecordPresentButUnreadable(pane, deps) };
	}
	// A record found under this pane's session must also CLAIM that session. One
	// copied from elsewhere passes every field check while describing another host's
	// pids and another shell's command, so classifying it would answer the ownership
	// question about the wrong process. The record is dropped, not trusted.
	// `record.paneId` is deliberately NOT compared: the host writes its own internal
	// pane label there (`<sessionId>:0`), never the coordinator's logical pane id.
	if (record.sessionId !== pane.sessionId) {
		return { pane, record: null, verdict: "dead", ownershipUnknown: true };
	}
	return {
		pane,
		record,
		verdict: await deps.classifyPane(record, deps.readPaneToken(pane.sessionId)),
		ownershipUnknown: false,
	};
}

/**
 * Whether the pane's record file exists yet cannot be interpreted. Falls back to
 * `false` when a caller supplies no inspector, which keeps every existing
 * in-memory dep double behaving exactly as it did.
 */
function paneRecordPresentButUnreadable(pane: MultipanePaneEntry, deps: CoordinatorDeps): boolean {
	const inspection = deps.inspectPaneRecord?.(pane.sessionId);
	if (!inspection || inspection.ok) return false;
	switch (inspection.problem.kind) {
		// Both mean "there is no record to read". A finished pane unlinks its record and
		// only then tries to remove its directory, which fails whenever a sibling file
		// survives — so a record-less directory is an ordinary dead pane, not a doubt.
		case "absent":
		case "missing":
			return false;
		default:
			return true;
	}
}

function snapshotOf({ pane, record, verdict }: PaneProbe): PaneSnapshot {
	const { paneId, sessionId } = pane;
	if (!record) {
		return {
			paneId,
			sessionId,
			hostPid: -1,
			shellPid: -1,
			hostStartSignature: "",
			shellStartSignature: "",
			cols: 0,
			rows: 0,
			state: "dead",
			publishesScreen: false,
		};
	}
	return {
		paneId,
		sessionId,
		hostPid: record.host.pid,
		shellPid: record.shell.pid,
		hostStartSignature: record.host.startSignature,
		shellStartSignature: record.shell.startSignature,
		cols: record.cols,
		rows: record.rows,
		state: verdict === "owned" ? "running" : verdict,
		publishesScreen: (record.capabilities?.capture?.length ?? 0) > 0,
	};
}

async function isPaneOwned(sessionId: string, deps: CoordinatorDeps): Promise<boolean> {
	const record = deps.readPaneRecord(sessionId);
	if (!record) return false;
	return (await deps.classifyPane(record, deps.readPaneToken(sessionId))) === "owned";
}

async function hasLivePane(record: NativeMultipaneRecord, deps: CoordinatorDeps): Promise<boolean> {
	for (const pane of record.panes) {
		if (await isPaneOwned(pane.sessionId, deps)) return true;
	}
	return false;
}

/** Release each pane's registry state through the registry's own ownership guard. */
async function dropPanes(panes: readonly MultipanePaneEntry[], deps: CoordinatorDeps): Promise<void> {
	for (const pane of panes) await deps.stopPane(pane.sessionId);
}
