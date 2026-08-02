/**
 * Column-agent pane ownership across a FRESH PROCESS, over real files.
 *
 * The claim this file has to earn: a review agent's pane is re-found and closed
 * by a dev3 that has no memory of ever opening it. Nothing here is remembered in
 * RAM — the launch command is read back from the on-disk session records, exactly
 * as it is after an app restart, so the module graph is reset and the only thing
 * carried between "runs" is the registry directory itself.
 *
 * A mock returning the desired command would prove nothing about that boundary,
 * so `nativeTaskPaneCommands` runs for real; only the coordinator's pane list and
 * the pane close are supplied, and the close deletes the real record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SESSIONS_DIR_ENV } from "../native-terminal-registry/paths";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	removeSessionState,
	writeRecordAtomic,
	type NativeSessionRecord,
} from "../native-terminal-registry/record";
import type { Task } from "../../shared/types";

const TASK_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SOCKET = "dev3-sock";
const nativeTask = { id: TASK_ID, seq: 4242, terminalBackend: "native" } as unknown as Task;

let sessionsDir: string;
/** The panes the coordinator still lists, in the order it lists them. */
let coordinatorPanes: { paneId: string; sessionId: string }[];

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

// The task's backend identity is read from the task record itself; nothing else
// about tmux is reachable, and any call would be a bug this test should catch.
vi.mock("../tmux", () => ({
	PANE_START_COMMAND_FORMAT: { formatString: "", parse: () => [] },
	TmuxError: class extends Error {},
	taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
	tmux: {
		listPanes: vi.fn(() => {
			throw new Error("a native task must not reach tmux");
		}),
		splitWindow: vi.fn(() => {
			throw new Error("a native task must not reach tmux");
		}),
		selectPane: vi.fn(),
		killPane: vi.fn(() => {
			throw new Error("a native task must not reach tmux");
		}),
	},
}));

vi.mock("../native-task-panes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../native-task-panes")>();
	const state = () => ({
		taskId: TASK_ID,
		panes: coordinatorPanes.map(({ paneId, sessionId }) => ({
			paneId,
			sessionId,
			hostPid: 1,
			shellPid: 2,
			cols: 80,
			rows: 24,
			alive: true,
		})),
		layout: null as never,
		activePaneId: coordinatorPanes[0]?.paneId ?? "",
	});
	return {
		...actual,
		nativeTaskPanesState: vi.fn(async () => state()),
		// REAL: both reads take each pane's launch command back off its on-disk record.
		nativeTaskPaneCommands: vi.fn(async () => actual.nativeTaskPaneCommandsOf(state())),
		nativeTaskPaneCommandsStrict: vi.fn(async () => {
			const panes = actual.nativeTaskPaneCommandsOf(state());
			return {
				kind: "read" as const,
				panes,
				unreadable: panes.filter((pane) => pane.command.length === 0).map((pane) => pane.paneId),
			};
		}),
		splitNativeTaskPane: vi.fn(async () => ({ paneId: "pane-new", state: state() })),
		// A real close: the record leaves the disk, so the verification re-read has
		// something honest to look at.
		closeNativeTaskPane: vi.fn(async (_taskId: string, paneId: string) => {
			const entry = coordinatorPanes.find((pane) => pane.paneId === paneId);
			if (entry) removeSessionState(entry.sessionId, null);
			coordinatorPanes = coordinatorPanes.filter((pane) => pane.paneId !== paneId);
			return { sessionTornDown: false, state: state() };
		}),
		focusNativeTaskPane: vi.fn(async () => state()),
	};
});

function record(sessionId: string, paneId: string, command: string[]): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 4242, executable: "/bin/bun", startSignature: "4242@t0" },
		shell: { pid: 4243, command, startSignature: "4243@t0" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-08-02T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
	};
}

/** Import task-aux-panes with an empty module registry — a fresh dev3 process. */
async function freshProcess() {
	vi.resetModules();
	return import("../task-aux-panes");
}

beforeEach(() => {
	sessionsDir = mkdtempSync(join(tmpdir(), "dev3-col-agent-recovery-"));
	process.env[NATIVE_SESSIONS_DIR_ENV] = sessionsDir;
	coordinatorPanes = [];
});

afterEach(() => {
	delete process.env[NATIVE_SESSIONS_DIR_ENV];
	rmSync(sessionsDir, { recursive: true, force: true });
});

describe("column-agent pane ownership after a restart (real records)", () => {
	it("re-finds and closes the review pane a previous process opened", async () => {
		// "Run one": a process that no longer exists opened the agent pane and a
		// review pane, leaving only these records behind.
		const first = await freshProcess();
		const marker = first.auxPaneMarker(TASK_ID, "columnAgent");
		writeRecordAtomic(record("sess-agent", "pane-1", ["/bin/zsh"]));
		writeRecordAtomic(record("sess-review", "pane-9", ["/bin/bash", marker]));
		coordinatorPanes = [
			{ paneId: "pane-1", sessionId: "sess-agent" },
			{ paneId: "pane-9", sessionId: "sess-review" },
		];

		// "Run two": a fresh module graph, so the only thing it can know is the disk.
		const restarted = await freshProcess();
		expect(await restarted.findAuxPanes(nativeTask, "columnAgent", SOCKET)).toEqual([
			{ backend: "native", paneId: "pane-9" },
		]);

		const handle = await restarted.openAuxPane({
			task: nativeTask,
			purpose: "columnAgent",
			placement: "right",
			size: "40%",
			cwd: "/tmp/wt",
			socket: SOCKET,
			title: "AI Review",
			tmuxCommand: `bash "${marker}"`,
			nativeLaunch: { executable: "/bin/bash", argv: [marker] },
		});

		expect(handle).toEqual({ backend: "native", paneId: "pane-new" });
		// The old pane is gone from the pane set AND from disk.
		expect(coordinatorPanes.map((pane) => pane.paneId)).toEqual(["pane-1"]);
		expect(await restarted.findAuxPanes(nativeTask, "columnAgent", SOCKET)).toEqual([]);
	});

	it("does not mistake the task's own agent pane for a review pane", async () => {
		const mod = await freshProcess();
		writeRecordAtomic(record("sess-agent", "pane-1", ["/bin/zsh"]));
		coordinatorPanes = [{ paneId: "pane-1", sessionId: "sess-agent" }];

		expect(await mod.findAuxPanes(nativeTask, "columnAgent", SOCKET)).toEqual([]);
	});

	it("re-finds every review pane when a previous process left more than one", async () => {
		const mod = await freshProcess();
		const marker = mod.auxPaneMarker(TASK_ID, "columnAgent");
		writeRecordAtomic(record("sess-agent", "pane-1", ["/bin/zsh"]));
		writeRecordAtomic(record("sess-a", "pane-8", ["/bin/bash", marker]));
		writeRecordAtomic(record("sess-b", "pane-9", ["/bin/bash", marker]));
		coordinatorPanes = [
			{ paneId: "pane-1", sessionId: "sess-agent" },
			{ paneId: "pane-8", sessionId: "sess-a" },
			{ paneId: "pane-9", sessionId: "sess-b" },
		];

		const restarted = await freshProcess();
		await restarted.openAuxPane({
			task: nativeTask,
			purpose: "columnAgent",
			placement: "right",
			size: "40%",
			cwd: "/tmp/wt",
			socket: SOCKET,
			title: "AI Review",
			tmuxCommand: `bash "${marker}"`,
			nativeLaunch: { executable: "/bin/bash", argv: [marker] },
		});

		expect(coordinatorPanes.map((pane) => pane.paneId)).toEqual(["pane-1"]);
		expect(await restarted.findAuxPanes(nativeTask, "columnAgent", SOCKET)).toEqual([]);
	});
});
