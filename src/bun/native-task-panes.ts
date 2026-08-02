/**
 * Product-facing native multi-pane runtime for one task (seq 1311, PR1).
 *
 * ONE owner: a single module-level NativeTerminalBackend instance holds every
 * coordinator. All operations go through it — create, recover/describe, split,
 * focus, close, cleanup. No NativeMultipaneCoordinator is constructed here
 * directly; native-only details (pids, SplitTree, geometry publish) are exposed
 * via native-only methods on the concrete NativeTerminalBackend class.
 *
 * A split pane inherits its cwd and env from the CALLER, which resolves them from
 * the task itself (worktree path + task lifecycle env). This module keeps no
 * per-process memory of them: after an app restart the pane set is recovered from
 * disk, and anything remembered only in RAM would be gone exactly when the user
 * clicks Split.
 *
 * Never touches tmux. Never constructs a second backend or coordinator.
 */

import { createLogger } from "./logger";
import type { SplitTree } from "../shared/split-tree";
import { serializeSplitTree } from "../shared/split-tree";
import { readRecord } from "./native-terminal-registry/record";
import { stop as stopSession } from "./native-terminal-registry/registry";
import {
	NativeTerminalBackend,
	nativeTaskSessionId,
	nativeTaskTerminalBackend,
	type TerminalLaunchSpec,
} from "./task-terminal-backend";
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

/**
 * ONE backend instance for the process lifetime. Holds all coordinator
 * instances; prevents double-ownership of on-disk coordinator records.
 */
let _backend: NativeTerminalBackend | null = null;

function getBackend(): NativeTerminalBackend {
	if (!_backend) _backend = nativeTaskTerminalBackend();
	return _backend;
}

/** @internal Exposed for tests only. Resets the singleton so tests get a fresh world. */
export function _resetBackendForTests(): void {
	_backend = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function coordinatorId(taskId: string): string {
	return nativeTaskSessionId(taskId);
}

async function buildState(taskId: string): Promise<NativeTaskPanesState> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	const [snapshots, layout] = await Promise.all([
		backend.listPanes(coordId),
		backend.paneLayout(coordId),
	]);
	const panes: NativeTaskPane[] = (snapshots ?? []).map((snap) => ({
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
		layout: layout ? serializeSplitTree(layout) : "",
		activePaneId: layout?.activePaneId ?? "",
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
	// A pane session id from the multi-pane era would not match the bare
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
	const backend = getBackend();

	log.info("Starting native task panes", { taskId: taskId.slice(0, 8), coordId });

	// Sweep any orphaned pre-multipane session before creating the coordinator.
	await sweepLegacySingleViewSession(taskId);

	await backend.openSession({ id: coordId, cwd, env, launch, size: { cols, rows } });

	const state = await buildState(taskId);
	log.info("Native task panes started", {
		taskId: taskId.slice(0, 8),
		paneCount: state.panes.length,
		firstPaneId: state.panes[0]?.paneId,
	});
	return state;
}

/**
 * Rediscover an existing pane set after an app restart. Never spawns.
 * Returns `null` when no coordinator record exists for this task.
 */
export async function recoverNativeTaskPanes(taskId: string): Promise<NativeTaskPanesState | null> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	const sessionState = await backend.describeSession(coordId);
	if (!sessionState) return null;
	return buildState(taskId);
}

/** Current pane set state; returns `null` when no live coordinator exists. */
export async function nativeTaskPanesState(taskId: string): Promise<NativeTaskPanesState | null> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	const sessionState = await backend.describeSession(coordId);
	if (!sessionState) return null;
	return buildState(taskId);
}

/**
 * Split an existing pane, spawning a new independent shell in the task's own
 * cwd and env — both required, so a split can never land in `/tmp` with an empty
 * environment.
 */
export async function splitNativeTaskPane(
	taskId: string,
	fromPaneId: string,
	orientation: SplitOrientation,
	spec: { cwd: string; env: Record<string, string>; launch?: TerminalLaunchSpec; cols?: number; rows?: number },
): Promise<{ paneId: string; state: NativeTaskPanesState }> {
	const { cwd, env } = spec;

	// Derive geometry from the source pane's record; fall back to 80×24 and log.
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	let cols = spec?.cols;
	let rows = spec?.rows;
	if (!cols || !rows) {
		const snapshots = await backend.listPanes(coordId);
		const sourceSnap = snapshots?.find((s) => s.paneId === fromPaneId);
		if (sourceSnap) {
			cols ??= sourceSnap.cols;
			rows ??= sourceSnap.rows;
		} else {
			log.warn("splitNativeTaskPane: source pane record unreadable; using 80×24 fallback", {
				taskId: taskId.slice(0, 8),
				fromPaneId,
			});
			cols ??= 80;
			rows ??= 24;
		}
	}

	// Split through the contract; the default shell runs in the task's cwd/env.
	let viewSpec: { cwd: string; env: Record<string, string>; launch?: TerminalLaunchSpec; orientation: SplitOrientation };
	if (spec?.launch) {
		viewSpec = { cwd, env, launch: spec.launch, orientation };
	} else {
		// Default shell: use the platform default in the task's cwd/env.
		const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd, env: process.env });
		const shellLaunch = defineShellLaunchSpec({ ...defaults, env });
		// Pass as TerminalLaunchSpec so the backend builds the right ShellLaunchSpec.
		viewSpec = {
			cwd,
			env,
			launch: { executable: shellLaunch.executable, argv: shellLaunch.argv },
			orientation,
		};
	}

	const second = await backend.splitView(coordId, fromPaneId, viewSpec);
	const state = await buildState(taskId);
	return { paneId: second.id, state };
}

/** Close a single pane. Closing the last pane tears the pane set down. */
export async function closeNativeTaskPane(
	taskId: string,
	paneId: string,
): Promise<{ sessionTornDown: boolean; state: NativeTaskPanesState | null }> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	await backend.closeView(coordId, paneId);
	const after = await backend.describeSession(coordId);
	if (!after) {
		return { sessionTornDown: true, state: null };
	}
	return { sessionTornDown: false, state: await buildState(taskId) };
}

/** Publish a geometry-only layout change (same pane set, new ratios/shape). */
export async function setNativeTaskPaneLayout(taskId: string, tree: SplitTree): Promise<NativeTaskPanesState> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	await backend.publishPaneGeometry(coordId, tree);
	return buildState(taskId);
}

/** Set the shared active pane (shared focus, not client-local). */
export async function focusNativeTaskPane(taskId: string, paneId: string): Promise<NativeTaskPanesState> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	await backend.focusView(coordId, paneId);
	return buildState(taskId);
}

/** Type into one native pane, exactly as a viewer's keystrokes would. */
export async function writeNativeTaskPane(taskId: string, paneId: string, data: string): Promise<void> {
	await getBackend().writePane(coordinatorId(taskId), paneId, data);
}

/**
 * Tear down every pane in a task's pane set and VERIFY they are gone.
 * Always verifies — an unconfirmed teardown throws whether or not this process
 * had a cached coordinator. A still-present coordinator would make the next
 * startNativeTaskPanes fail with session-exists.
 */
export async function stopNativeTaskPanes(taskId: string): Promise<void> {
	const backend = getBackend();
	const coordId = coordinatorId(taskId);
	await backend.cleanupSession(coordId, { ignoreMissing: true });
	const after = await backend.describeSession(coordId);
	if (after !== null) {
		throw new Error(
			`native pane set for task ${taskId.slice(0, 8)} is still present after teardown — some panes did not exit`,
		);
	}
	log.info("Native task panes stopped", { taskId: taskId.slice(0, 8) });
}

/**
 * The launch command behind every pane of a task, read from the per-pane
 * registry records.
 *
 * This is the native counterpart of tmux's `#{pane_start_command}` listing: it
 * lets a caller re-find a pane it started earlier — after an app restart, when
 * no in-memory ownership map survives — by matching the command it launched.
 * Panes whose record is unreadable are reported with an empty command rather
 * than dropped, so the caller still sees the pane exists.
 */
export async function nativeTaskPaneCommands(
	taskId: string,
): Promise<Array<{ paneId: string; sessionId: string; command: string[]; shellPid: number; alive: boolean }>> {
	const state = await nativeTaskPanesState(taskId);
	if (!state) return [];
	return state.panes.map((pane) => ({
		paneId: pane.paneId,
		sessionId: pane.sessionId,
		command: readRecord(pane.sessionId)?.shell.command ?? [],
		shellPid: pane.shellPid,
		alive: pane.alive,
	}));
}

/**
 * True when the coordinator record exists and contains at least one owned pane.
 * Read-only: does NOT register or cache the recovered coordinator as a side effect.
 */
export async function nativeTaskPanesAlive(taskId: string): Promise<boolean> {
	// describeSession always calls recover() under the hood (decision 169),
	// which reconciles dead panes — a non-null result means ≥1 pane is alive.
	return (await getBackend().describeSession(coordinatorId(taskId))) !== null;
}
