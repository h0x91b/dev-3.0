/**
 * "I could not tell" must never read as "there is nothing there" — over the REAL
 * native discovery path.
 *
 * Three production behaviours each collapse an undecidable read into an empty
 * list, and any of them would let a second review agent open beside a live one:
 *
 *  • `NativeTerminalBackend.readPaneSet` catches every recovery exception and
 *    returns `null`;
 *  • `nativeTaskPaneCommands` turns a `null` pane set into `[]`;
 *  • `nativeTaskPaneCommandsOf` turns a pane whose own record is unreadable into
 *    `command: []`, so it matches no marker.
 *
 * So nothing here mocks the module under test. The registry directory is real, the
 * records are real files, and the failures are injected where they actually happen:
 * in `recoverPaneSet` and in the per-pane record on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SESSIONS_DIR_ENV, recordFile, sessionDir } from "../native-terminal-registry/paths";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	writeRecordAtomic,
	type NativeSessionRecord,
} from "../native-terminal-registry/record";
import type { Task } from "../../shared/types";

const TASK_ID = "dddddddd-0000-0000-0000-000000000004";
const SOCKET = "dev3-sock";
const nativeTask = { id: TASK_ID, seq: 909, terminalBackend: "native" } as unknown as Task;

/** What the coordinator's recovery does when asked for this task's pane set. */
let recovery: () => Promise<{ panes: { paneId: string; sessionId: string }[] } | null>;

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
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

// The ONE injection point: the coordinator's own recovery. Everything above it —
// readPaneSet's catch, buildState's null handling, the per-pane record read — is
// the real production code.
vi.mock("../native-terminal-multipane/coordinator", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../native-terminal-multipane/coordinator")>();
	return {
		...actual,
		NativeMultipaneCoordinator: class {
			static async recoverPaneSet() {
				const recovered = await recovery();
				if (!recovered) return null;
				return {
					coordinator: { layout: { activePaneId: recovered.panes[0]?.paneId ?? "", root: null } },
					panes: recovered.panes.map(({ paneId, sessionId }) => ({
						paneId,
						sessionId,
						hostPid: 1,
						shellPid: 2,
						cols: 80,
						rows: 24,
						state: "alive",
					})),
				};
			}
		},
	};
});
vi.mock("../../shared/split-tree", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../shared/split-tree")>()),
	serializeSplitTree: () => "layout",
}));

const {
	auxPaneMarker,
	findAuxPanes,
	openAuxPane,
	AuxPaneUndecidableError,
} = await import("../task-aux-panes");
const { splitNativeTaskPane } = await import("../native-task-panes");
const nativePanes = await import("../native-task-panes");

let sessionsDir: string;

function record(sessionId: string, paneId: string, command: string[]): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 1, executable: "/bin/bun", startSignature: "1@t0" },
		shell: { pid: 2, command, startSignature: "2@t0" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-08-02T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
	};
}

function columnSpec() {
	const marker = auxPaneMarker(TASK_ID, "columnAgent");
	return {
		task: nativeTask,
		purpose: "columnAgent" as const,
		placement: "right" as const,
		size: "40%",
		cwd: "/tmp/wt",
		socket: SOCKET,
		title: "AI Review",
		tmuxCommand: `bash "${marker}"`,
		nativeLaunch: { executable: "/bin/bash", argv: [marker] },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionsDir = mkdtempSync(join(tmpdir(), "dev3-strict-discovery-"));
	process.env[NATIVE_SESSIONS_DIR_ENV] = sessionsDir;
	nativePanes._resetBackendForTests();
	recovery = async () => null;
});

afterEach(() => {
	delete process.env[NATIVE_SESSIONS_DIR_ENV];
	rmSync(sessionsDir, { recursive: true, force: true });
});

describe("strict native discovery for a proven replacement", () => {
	it("refuses when recovery throws, instead of reading it as an empty pane set", async () => {
		recovery = async () => {
			throw new Error("ownership sweep failed");
		};

		// The tolerant read is what production does elsewhere, and it hides this.
		await expect(nativePanes.nativeTaskPaneCommands(TASK_ID)).resolves.toEqual([]);
		// The replacement path must not accept that answer.
		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).rejects.toThrow(/ownership sweep/);
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(splitNativeTaskPane).toBeDefined();
	});

	it("refuses when a pane's own launch command cannot be read", async () => {
		const marker = auxPaneMarker(TASK_ID, "columnAgent");
		writeRecordAtomic(record("sess-agent", "pane-1", ["/bin/zsh"]));
		writeRecordAtomic(record("sess-review", "pane-9", ["/bin/bash", marker]));
		// A record that exists but cannot be parsed — the case that silently becomes
		// `command: []` and therefore matches no marker.
		writeFileSync(join(sessionDir("sess-review"), "record.json"), "{ not json");
		recovery = async () => ({
			panes: [
				{ paneId: "pane-1", sessionId: "sess-agent" },
				{ paneId: "pane-9", sessionId: "sess-review" },
			],
		});

		// Tolerant read: the review pane looks like it is not there at all.
		const tolerant = await nativePanes.nativeTaskPaneCommands(TASK_ID);
		expect(tolerant.find((pane) => pane.paneId === "pane-9")?.command).toEqual([]);
		// Strict read refuses rather than opening a second agent beside it.
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
	});

	it("treats a genuinely absent pane set as owning nothing, not as undecidable", async () => {
		recovery = async () => null;

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).resolves.toEqual([]);
	});

	it("keeps the tolerant read tolerant for the best-effort purposes", async () => {
		recovery = async () => {
			throw new Error("ownership sweep failed");
		};

		await expect(findAuxPanes(nativeTask, "devServer", SOCKET)).resolves.toEqual([]);
	});

	it("reads a healthy pane set through the real record files", async () => {
		const marker = auxPaneMarker(TASK_ID, "columnAgent");
		writeRecordAtomic(record("sess-agent", "pane-1", ["/bin/zsh"]));
		writeRecordAtomic(record("sess-review", "pane-9", ["/bin/bash", marker]));
		recovery = async () => ({
			panes: [
				{ paneId: "pane-1", sessionId: "sess-agent" },
				{ paneId: "pane-9", sessionId: "sess-review" },
			],
		});

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).resolves.toEqual([
			{ backend: "native", paneId: "pane-9" },
		]);
		expect(recordFile("sess-review")).toContain("sess-review");
	});
});
