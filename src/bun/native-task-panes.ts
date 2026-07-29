/**
 * Product-facing native multi-pane runtime for one task (seq 1311, PR1).
 *
 * Owns a process-wide map of taskId → live coordinator, and exposes the
 * stable pane-set lifecycle the pty-server layer needs: start, split, close,
 * focus, geometry, stop, and recover.
 *
 * Every operation goes through the terminal-backend seam where the contract
 * covers it; direct coordinator calls are used for coordinator-native
 * operations (geometry, layout) that have no seam equivalent.
 *
 * Launch dialect re-derived from task data, not persisted separately — a
 * fresh app process after restart calls recoverNativeTaskPanes, which reads
 * the coordinator record to discover existing panes and re-connects without
 * spawning.
 */

import { createLogger } from "./logger";
import { NativeMultipaneCoordinator } from "./native-terminal-multipane/coordinator";
import type { SplitTree } from "../shared/split-tree";
import { serializeSplitTree } from "../shared/split-tree";
import { readRecord } from "./native-terminal-registry/record";
import { stop as stopSession } from "./native-terminal-registry/registry";
import { nativeTaskSessionId, nativeTaskTerminalBackend, type TerminalLaunchSpec } from "./task-terminal-backend";
import {
	defineShellLaunchSpec,
	defaultNativeShellLaunchSpec,
} from "./native-terminal-registry/shell-launch";
import type { SplitOrientation } from "../shared/split-tree";

const log = createLogger("native-task-panes");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NativeTaskPane {
	paneId: string;
	/** Registry session id backing this pane. */
	sessionId: string;
	hostPid: number;
	shellPid: number;
	cols: number;
	rows: number;
	alive: boolean;
}

export interface NativeTaskPanesState {
	taskId: string;
	panes: NativeTaskPane[];
	/** Serialized shared SplitTree (membership + geometry). */
	layout: string;
	activePaneId: string;
}

export interface StartNativeTaskPanesSpec {
	taskId: string;
	cwd: string;
	env: Record<string, string>;
	launch: TerminalLaunchSpec;
	cols: number;
	rows: number;
}

// ── Internal state ────────────────────────────────────────────────────────────

/** Live coordinators for running tasks. Keyed by taskId. */
const liveCoordinators = new Map<string, NativeMultipaneCoordinator>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function coordinatorId(taskId: string): string {
	return nativeTaskSessionId(taskId);
}

function makePaneLaunchSpec(
	cwd: string,
	env: Record<string, string>,
	launch: TerminalLaunchSpec,
	cols: number,
	rows: number,
) {
	const shellLaunch = defineShellLaunchSpec({
		executable: launch.executable,
		argv: [...launch.argv],
		cwd,
		env,
	});
	return { launch: shellLaunch, cols, rows };
}

function defaultPaneLaunchSpec(cwd: string, env: Record<string, string>, cols: number, rows: number) {
	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd, env: process.env });
	const shellLaunch = defineShellLaunchSpec({ ...defaults, env });
	return { launch: shellLaunch, cols, rows };
}

async function buildState(taskId: string, coordinator: NativeMultipaneCoordinator): Promise<NativeTaskPanesState> {
	const paneSnapshots = await coordinator.listPanes();
	const panes: NativeTaskPane[] = paneSnapshots.map((snap) => ({
		paneId: snap.paneId,
		sessionId: snap.sessionId,
		hostPid: snap.hostPid,
		shellPid: snap.shellPid,
		cols: snap.cols,
		rows: snap.rows,
		alive: snap.state !== "dead",
	}));
	return {
		taskId,
		panes,
		layout: serializeSplitTree(coordinator.layout),
		activePaneId: coordinator.layout.activePaneId,
	};
}

/**
 * Tear down any legacy single-view native session that was created before the
 * multi-pane migration. The old single-view backend used the coordinator id
 * directly as a registry session id (no `-pane-N` suffix). If one is still
 * live it would keep an invisible shell alive forever, and the next
 * coordinator create would collide with it.
 */
async function sweepLegacySingleViewSession(taskId: string): Promise<void> {
	const legacyId = nativeTaskSessionId(taskId);
	const record = readRecord(legacyId);
	if (!record) return;
	// A pane-0 session id from the multi-pane era would not match the bare
	// coordinator id — the legacy id has no "-pane-N" suffix. If we find one
	// that has the bare id, it is pre-migration.
	if (record.sessionId !== legacyId) return;
	log.warn("Sweeping legacy single-view native session before creating multi-pane coordinator", {
		taskId: taskId.slice(0, 8),
		legacySessionId: legacyId,
	});
	await stopSession(legacyId).catch((err) =>
		log.error("Failed to stop legacy single-view session", { legacyId, error: String(err) }),
	);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Create a new pane set for a task. Fails if one already exists. */
export async function startNativeTaskPanes(spec: StartNativeTaskPanesSpec): Promise<NativeTaskPanesState> {
	const { taskId, cwd, env, launch, cols, rows } = spec;
	const coordId = coordinatorId(taskId);
	const backend = nativeTaskTerminalBackend();

	log.info("Starting native task panes", { taskId: taskId.slice(0, 8), coordId });

	// Sweep any orphaned pre-multipane session before creating the coordinator.
	await sweepLegacySingleViewSession(taskId);

	await backend.openSession({
		id: coordId,
		cwd,
		env,
		launch,
		size: { cols, rows },
	});

	// Recover the coordinator the backend just created so we have a live handle.
	const coordinator = await NativeMultipaneCoordinator.recover(coordId);
	if (!coordinator) throw new Error(`coordinator ${coordId} vanished immediately after creation`);
	liveCoordinators.set(taskId, coordinator);

	const paneState = await buildState(taskId, coordinator);
	log.info("Native task panes started", {
		taskId: taskId.slice(0, 8),
		paneCount: paneState.panes.length,
		firstPaneId: paneState.panes[0]?.paneId,
	});
	return paneState;
}

/**
 * Rediscover an existing pane set after an app restart. Never spawns.
 * Returns `null` when no coordinator record exists for this task.
 */
export async function recoverNativeTaskPanes(taskId: string): Promise<NativeTaskPanesState | null> {
	const coordId = coordinatorId(taskId);
	const existing = liveCoordinators.get(taskId);
	if (existing) return buildState(taskId, existing);

	const coordinator = await NativeMultipaneCoordinator.recover(coordId);
	if (!coordinator) return null;
	liveCoordinators.set(taskId, coordinator);
	return buildState(taskId, coordinator);
}

/** Current pane set state; returns `null` when no live coordinator exists. */
export async function nativeTaskPanesState(taskId: string): Promise<NativeTaskPanesState | null> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) return null;
	return buildState(taskId, coordinator);
}

/** Split an existing pane, spawning an independent shell. */
export async function splitNativeTaskPane(
	taskId: string,
	fromPaneId: string,
	orientation: SplitOrientation,
	spec?: { cwd?: string; env?: Record<string, string>; launch?: TerminalLaunchSpec; cols?: number; rows?: number },
): Promise<{ paneId: string; state: NativeTaskPanesState }> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) throw new Error(`no live native pane set for task ${taskId.slice(0, 8)}`);

	// Inherit defaults from first pane's record when not explicitly supplied.
	const firstPaneSessionId = coordinator.sessionIdFor(coordinator.paneIds()[0]!);
	const firstRecord = readRecord(firstPaneSessionId);
	const cwd = spec?.cwd ?? firstRecord?.shell.command[0] ?? "/tmp";
	const env = spec?.env ?? {};
	const cols = spec?.cols ?? firstRecord?.cols ?? 80;
	const rows = spec?.rows ?? firstRecord?.rows ?? 24;

	let paneSpec: { launch: ReturnType<typeof defineShellLaunchSpec>; cols?: number; rows?: number };
	if (spec?.launch) {
		paneSpec = makePaneLaunchSpec(cwd, env, spec.launch, cols, rows);
	} else {
		paneSpec = defaultPaneLaunchSpec(cwd, env, cols, rows);
	}

	const newPaneId = await coordinator.split(fromPaneId, orientation, paneSpec);
	const state = await buildState(taskId, coordinator);
	return { paneId: newPaneId, state };
}

/** Close a single pane. Closing the last pane tears the pane set down. */
export async function closeNativeTaskPane(
	taskId: string,
	paneId: string,
): Promise<{ sessionTornDown: boolean; state: NativeTaskPanesState | null }> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) throw new Error(`no live native pane set for task ${taskId.slice(0, 8)}`);

	const result = await coordinator.closePane(paneId);
	if (result.sessionTornDown) {
		liveCoordinators.delete(taskId);
		return { sessionTornDown: true, state: null };
	}
	const state = await buildState(taskId, coordinator);
	return { sessionTornDown: false, state };
}

/** Publish a geometry-only layout change (same pane set, new ratios/shape). */
export async function setNativeTaskPaneLayout(taskId: string, tree: SplitTree): Promise<NativeTaskPanesState> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) throw new Error(`no live native pane set for task ${taskId.slice(0, 8)}`);
	await coordinator.publishGeometry(tree);
	return buildState(taskId, coordinator);
}

/** Set the shared active pane (shared focus, not client-local). */
export async function focusNativeTaskPane(taskId: string, paneId: string): Promise<NativeTaskPanesState> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) throw new Error(`no live native pane set for task ${taskId.slice(0, 8)}`);
	const backend = nativeTaskTerminalBackend();
	const coordId = coordinatorId(taskId);
	await backend.focusView(coordId, paneId);
	// Re-read after the backend published the new active pane.
	const updated = await NativeMultipaneCoordinator.recover(coordId);
	if (updated) liveCoordinators.set(taskId, updated);
	return buildState(taskId, liveCoordinators.get(taskId) ?? coordinator);
}

/**
 * Tear down every pane in a task's pane set and verify they are gone.
 * Throws when any pane is still present after teardown.
 */
export async function stopNativeTaskPanes(taskId: string): Promise<void> {
	const coordinator = liveCoordinators.get(taskId);
	liveCoordinators.delete(taskId);

	const backend = nativeTaskTerminalBackend();
	const coordId = coordinatorId(taskId);
	await backend.cleanupSession(coordId, { ignoreMissing: true });

	// Verify the coordinator record is gone.
	if (coordinator) {
		const after = await NativeMultipaneCoordinator.recover(coordId);
		if (after) {
			throw new Error(
				`native pane set for task ${taskId.slice(0, 8)} is still present after teardown — some panes did not exit`,
			);
		}
	}
	log.info("Native task panes stopped", { taskId: taskId.slice(0, 8) });
}

/** True when a live coordinator with at least one owned pane exists for this task. */
export async function nativeTaskPanesAlive(taskId: string): Promise<boolean> {
	const coordinator = liveCoordinators.get(taskId);
	if (!coordinator) {
		const state = await recoverNativeTaskPanes(taskId);
		return state !== null && state.panes.some((p) => p.alive);
	}
	const panes = await coordinator.listPanes();
	return panes.some((p) => p.state !== "dead");
}
