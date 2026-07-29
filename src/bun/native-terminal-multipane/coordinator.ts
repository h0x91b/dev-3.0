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
import { withFileLock } from "../file-lock";
import { NativeSessionClient } from "../native-terminal-registry/client";
import { classifyOwnership, type OwnershipVerdict } from "../native-terminal-registry/ownership";
import type { ClientRole } from "../native-terminal-registry/writer-ownership";
import { readRecord, readToken, type NativeSessionRecord } from "../native-terminal-registry/record";
import { start, stop, type StartOptions, type StartResult } from "../native-terminal-registry/registry";
import type { ShellLaunchSpec } from "../native-terminal-registry/shell-launch";
import { CoordinatorClientView } from "./client-view";
import { MonotonicSnapshotView } from "../native-terminal-adapter/view-reconstruction";
import { readParserState } from "../native-terminal-registry/parser-state";
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
	cols: number;
	rows: number;
	state: "running" | "reused" | "dead";
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
	/** Point-in-time screen capture; returns `""` when the surface has nothing. */
	capture(includeHistory: boolean): string;
	close(): void;
}

/** Injected effects, so the coordinator is unit-testable without real processes. */
export interface CoordinatorDeps {
	startPane(sessionId: string, opts: StartOptions): Promise<StartResult>;
	stopPane(sessionId: string, opts?: { timeoutMs?: number }): Promise<boolean>;
	readPaneRecord(sessionId: string): NativeSessionRecord | null;
	readPaneToken(sessionId: string): string | null;
	classifyPane(record: NativeSessionRecord, token: string | null): Promise<OwnershipVerdict>;
	connectPane(record: NativeSessionRecord, token: string): Promise<PaneConnection>;
}

export const defaultCoordinatorDeps: CoordinatorDeps = {
	startPane: (sessionId, opts) => start(sessionId, opts),
	stopPane: (sessionId, opts) => stop(sessionId, opts ?? {}),
	readPaneRecord: readRecord,
	readPaneToken: readToken,
	classifyPane: classifyOwnership,
	async connectPane(record, token) {
		const client = new NativeSessionClient();
		await client.connect(record, token, { timeoutMs: 5000 });
		// Use the same snapshot surface the single-view adapter uses for capture.
		const surface = new MonotonicSnapshotView(record.sessionId, readParserState);
		return {
			role: () => client.getRole(),
			onOutput: (cb) => client.onOutput(cb),
			input: (data) => client.input(data),
			resize: (cols, rows) => client.resize(cols, rows),
			capture: (includeHistory) => surface.capture(includeHistory) ?? "",
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
				const existing = readMultipaneRecord(coordinatorId);
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
		return withFileLock(
			coordinatorRecordFile(coordinatorId),
			async () => {
				const record = readMultipaneRecord(coordinatorId);
				if (!record) return null;
				const tree = restoreSplitTree(record.layout);
				if (!tree) return null;

				const dead: MultipanePaneEntry[] = [];
				for (const pane of record.panes) {
					if (!(await isPaneOwned(pane.sessionId, deps))) dead.push(pane);
				}
				if (dead.length === 0) {
					return new NativeMultipaneCoordinator(coordinatorId, record.epoch, tree, deps);
				}
				if (dead.length === record.panes.length) {
					await dropPanes(record.panes, deps);
					removeMultipaneRecord(coordinatorId, record.epoch);
					return null;
				}
				let reconciled = tree;
				for (const pane of dead) reconciled = closeTreePane(reconciled, pane.paneId);
				reconciled = normalizeSharedLayout(reconciled);
				await dropPanes(dead, deps);
				writeMultipaneRecordAtomic(
					buildRecord(coordinatorId, record.epoch, reconciled, bindPanes(coordinatorId, reconciled)),
				);
				return new NativeMultipaneCoordinator(coordinatorId, record.epoch, reconciled, deps);
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

	/** Per-pane host/shell identity, read from each pane's own registry record. */
	async listPanes(): Promise<PaneSnapshot[]> {
		const out: PaneSnapshot[] = [];
		for (const paneId of this.paneIds()) {
			const sessionId = paneSessionId(this.coordinatorId, paneId);
			const record = this.deps.readPaneRecord(sessionId);
			if (!record) {
				out.push({ paneId, sessionId, hostPid: -1, shellPid: -1, cols: 0, rows: 0, state: "dead" });
				continue;
			}
			const verdict = await this.deps.classifyPane(record, this.deps.readPaneToken(sessionId));
			out.push({
				paneId,
				sessionId,
				hostPid: record.host.pid,
				shellPid: record.shell.pid,
				cols: record.cols,
				rows: record.rows,
				state: verdict === "owned" ? "running" : verdict,
			});
		}
		return out;
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

	/** Point-in-time screen capture for one pane; returns `""` when unavailable. */
	async capturePane(paneId: string, includeHistory: boolean): Promise<string> {
		this.assertPane(paneId);
		const connection = await this.connect(paneId);
		return connection.capture(includeHistory);
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
			// Clear client-local zoom; preserve activePaneId (shared focus).
			this.publish({ ...tree, zoomedPaneId: null });
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
