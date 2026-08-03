/**
 * "I could not tell" must never read as "there is nothing there" — through the REAL
 * coordinator, over REAL registry files.
 *
 * The trap is not one function but a chain, and every link is production code here:
 * `probePane` reads a pane's record and, finding none, used to call it dead;
 * `recoverPaneSet` then filtered that pane out of the set, rewrote the coordinator
 * record and called `stopPane`, which reports success for a record it cannot read
 * without ever proving the process died. So the pane vanished, its shell survived,
 * and the strict command read never saw it — a second review agent could open
 * beside a live unknown process.
 *
 * Nothing about that chain is mocked. The coordinator is the real class, the
 * coordinator and pane records are real files in real temp dirs, and record reads
 * go through the real registry. Only three deps are controlled, because they leave
 * the machine: pane start, pane stop, and the `ps` ownership probe — and start/stop
 * are asserted to stay untouched, which is the point of the strict path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSplitTree, listPaneIds, restoreSplitTree, serializeSplitTree, splitPane } from "../../shared/split-tree";
import { NATIVE_SESSIONS_DIR_ENV, sessionDir } from "../native-terminal-registry/paths";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	writeRecordAtomic,
	type NativeSessionRecord,
} from "../native-terminal-registry/record";
import { NATIVE_MULTIPANE_DIR_ENV, coordinatorRecordFile } from "../native-terminal-multipane/paths";
import {
	NATIVE_MULTIPANE_SCHEMA_VERSION,
	readMultipaneRecord,
	writeMultipaneRecordAtomic,
} from "../native-terminal-multipane/record";
import type { Task } from "../../shared/types";

const TASK_ID = "dddddddd-0000-0000-0000-000000000004";
const COORD_ID = `dev3-task-${TASK_ID}`;
const SOCKET = "dev3-sock";
const nativeTask = { id: TASK_ID, seq: 909, terminalBackend: "native" } as unknown as Task;

const mocks = vi.hoisted(() => ({
	registryStart: vi.fn(),
	registryStop: vi.fn(async () => true),
	classifyOwnership: vi.fn(async () => "owned" as const),
}));

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

// Only what would leave the machine. Record reads stay real, so the coordinator
// still decides from the files on disk.
vi.mock("../native-terminal-registry/registry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../native-terminal-registry/registry")>()),
	start: mocks.registryStart,
	stop: mocks.registryStop,
}));
vi.mock("../native-terminal-registry/ownership", async (importOriginal) => ({
	...(await importOriginal<typeof import("../native-terminal-registry/ownership")>()),
	classifyOwnership: mocks.classifyOwnership,
}));

const { auxPaneMarker, findAuxPanes, openAuxPane, AuxPaneUndecidableError } = await import("../task-aux-panes");
const nativePanes = await import("../native-task-panes");
const { PaneOwnershipUnknownError } = await import("../native-terminal-multipane/coordinator");

let sessionsDir: string;
let multipaneDir: string;

function paneRecord(sessionId: string, paneId: string, command: string[]): NativeSessionRecord {
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

/** Two panes on disk: the task's own agent, and a review agent beside it. */
function writeTwoPaneSet(reviewCommand: string[]): void {
	let tree = createSplitTree();
	const agentPane = listPaneIds(tree)[0]!;
	tree = splitPane(tree, agentPane, "horizontal");
	const reviewPane = listPaneIds(tree).find((paneId) => paneId !== agentPane)!;
	writeRecordAtomic(paneRecord(`${COORD_ID}-${agentPane}`, agentPane, ["/bin/zsh"]));
	writeRecordAtomic(paneRecord(`${COORD_ID}-${reviewPane}`, reviewPane, reviewCommand));
	writeMultipaneRecordAtomic({
		schemaVersion: NATIVE_MULTIPANE_SCHEMA_VERSION,
		coordinatorId: COORD_ID,
		epoch: "epoch-1",
		updatedAt: "2026-08-02T00:00:00.000Z",
		layout: serializeSplitTree(tree),
		panes: [
			{ paneId: agentPane, sessionId: `${COORD_ID}-${agentPane}` },
			{ paneId: reviewPane, sessionId: `${COORD_ID}-${reviewPane}` },
		],
	});
}

/**
 * Three panes: the task's own agent, a review agent, and a third pane. Enough to
 * hold one owned, one provably dead and one unidentifiable pane at the same time,
 * which two panes cannot (a wholly dead set is removed instead of reconciled).
 */
function writeThreePaneSet(reviewCommand: string[]): { agent: string; review: string; third: string } {
	let tree = createSplitTree();
	const agentPane = listPaneIds(tree)[0]!;
	tree = splitPane(tree, agentPane, "horizontal");
	const reviewPane = listPaneIds(tree).find((paneId) => paneId !== agentPane)!;
	tree = splitPane(tree, reviewPane, "vertical");
	const thirdPane = listPaneIds(tree).find((paneId) => paneId !== agentPane && paneId !== reviewPane)!;
	const commands: Record<string, string[]> = {
		[agentPane]: ["/bin/zsh"],
		[reviewPane]: reviewCommand,
		[thirdPane]: ["/bin/zsh"],
	};
	for (const paneId of listPaneIds(tree)) {
		writeRecordAtomic(paneRecord(`${COORD_ID}-${paneId}`, paneId, commands[paneId]!));
	}
	writeMultipaneRecordAtomic({
		schemaVersion: NATIVE_MULTIPANE_SCHEMA_VERSION,
		coordinatorId: COORD_ID,
		epoch: "epoch-1",
		updatedAt: "2026-08-02T00:00:00.000Z",
		layout: serializeSplitTree(tree),
		panes: listPaneIds(tree).map((paneId) => ({ paneId, sessionId: `${COORD_ID}-${paneId}` })),
	});
	return { agent: agentPane, review: reviewPane, third: thirdPane };
}

function reviewPaneSessionId(): string {
	return readMultipaneRecord(COORD_ID)!.panes[1]!.sessionId;
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
	mocks.registryStop.mockResolvedValue(true);
	mocks.classifyOwnership.mockResolvedValue("owned");
	sessionsDir = mkdtempSync(join(tmpdir(), "dev3-strict-sessions-"));
	multipaneDir = mkdtempSync(join(tmpdir(), "dev3-strict-multipane-"));
	process.env[NATIVE_SESSIONS_DIR_ENV] = sessionsDir;
	process.env[NATIVE_MULTIPANE_DIR_ENV] = multipaneDir;
	nativePanes._resetBackendForTests();
});

afterEach(() => {
	delete process.env[NATIVE_SESSIONS_DIR_ENV];
	delete process.env[NATIVE_MULTIPANE_DIR_ENV];
	rmSync(sessionsDir, { recursive: true, force: true });
	rmSync(multipaneDir, { recursive: true, force: true });
});

describe("strict native discovery, through the real coordinator", () => {
	it("finds the review pane when every record is readable", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);

		const found = await findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true });

		expect(found).toHaveLength(1);
		expect(mocks.registryStop).not.toHaveBeenCalled();
	});

	it("refuses instead of reconciling away a pane whose record is corrupt", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		const before = readMultipaneRecord(COORD_ID)!;
		// The record file exists but no longer parses — the process it described may
		// well still be running.
		writeFileSync(join(sessionDir(reviewSession), "record.json"), "{ not json");

		// What tolerant recovery does with it, i.e. the trap: the pane is swept out of
		// the set, the coordinator record is rewritten, and stop() is told to drop it.
		const tolerant = await nativePanes.nativeTaskPaneCommands(TASK_ID);
		expect(tolerant.map((pane) => pane.sessionId)).not.toContain(reviewSession);
		// Whatever tolerant recovery decides to show, the pane's own record must stay
		// on disk: erasing it is what would let a later strict read answer "nothing
		// here" for a process that is still running.
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.sessionId)).toContain(reviewSession);

		// Rebuild the same situation and take the strict path instead.
		vi.clearAllMocks();
		mocks.registryStop.mockResolvedValue(true);
		mocks.classifyOwnership.mockResolvedValue("owned");
		nativePanes._resetBackendForTests();
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const rebuilt = readMultipaneRecord(COORD_ID)!;
		writeFileSync(join(sessionDir(reviewPaneSessionId()), "record.json"), "{ not json");

		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);

		// No new pane, no process touched, and the set is exactly as it was found.
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readMultipaneRecord(COORD_ID)).toEqual(rebuilt);
		expect(before.panes).toHaveLength(2);
	});

	it("refuses on a record written by a schema it does not understand, too", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		const snapshot = readMultipaneRecord(COORD_ID)!;
		// Parses fine, describes a live host, and says nothing this version can act on:
		// another installed version of the app may own that process.
		writeFileSync(
			join(sessionDir(reviewSession), "record.json"),
			JSON.stringify({ schemaVersion: NATIVE_SESSION_SCHEMA_VERSION + 7, sessionId: reviewSession }),
		);

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).rejects.toBeInstanceOf(
			PaneOwnershipUnknownError,
		);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readMultipaneRecord(COORD_ID)).toEqual(snapshot);
	});

	// Where the line is drawn, and why it is not drawn at "the record is unreadable
	// for any reason at all". A finished pane unlinks its record and then tries to
	// remove its directory, which fails whenever a sibling file survives — so "the
	// directory is there but holds no record" is an ORDINARY dead pane. Calling that
	// undecidable would wedge AI Review on every task that ever closed a pane.
	it("sweeps a pane that left its directory behind without a record", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		rmSync(join(sessionDir(reviewSession), "record.json"), { force: true });

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).resolves.toEqual([]);
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.sessionId)).not.toContain(reviewSession);
	});

	it("sweeps a pane whose session directory is gone entirely", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		rmSync(sessionDir(reviewSession), { recursive: true, force: true });

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).resolves.toEqual([]);
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.sessionId)).not.toContain(reviewSession);
	});

	// THE REAL SEQUENCE. TaskTerminal polls taskPaneState continuously, so by the time
	// the user clicks AI Review the tolerant path has already run several times. If a
	// poll had swept the unknown-owner pane out of the coordinator record, the strict
	// read that follows would find a clean, empty set and open a second agent beside a
	// process nobody can account for.
	it("still refuses after renderer-style tolerant polling has already run", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		const snapshot = readMultipaneRecord(COORD_ID)!;
		writeFileSync(join(sessionDir(reviewSession), "record.json"), "{ not json");

		// Three polls, exactly as the terminal view would issue them.
		for (let poll = 0; poll < 3; poll++) await nativePanes.nativeTaskPanesState(TASK_ID);

		// The evidence survived every one of them.
		expect(readMultipaneRecord(COORD_ID)).toEqual(snapshot);
		expect(mocks.registryStop).not.toHaveBeenCalled();

		// And the click that follows is refused, with nothing started.
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readMultipaneRecord(COORD_ID)).toEqual(snapshot);
	});

	it("hides the unidentifiable pane from a tolerant read without deleting it", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const reviewSession = reviewPaneSessionId();
		writeFileSync(join(sessionDir(reviewSession), "record.json"), "{ not json");

		const state = await nativePanes.nativeTaskPanesState(TASK_ID);

		// The UI does not show a pane it cannot describe...
		expect(state!.panes.map((pane) => pane.sessionId)).not.toContain(reviewSession);
		// ...but the record still says the task owns it.
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.sessionId)).toContain(reviewSession);
	});

	it("refuses when the COORDINATOR record itself is corrupt, and changes nothing", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const corrupt = "{ not a coordinator record";
		writeFileSync(coordinatorRecordFile(COORD_ID), corrupt);

		// The tolerant read cannot tell this from "no pane set at all".
		await expect(nativePanes.nativeTaskPanesState(TASK_ID)).resolves.toBeNull();
		// The strict one refuses instead of inventing an empty set.
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readFileSync(coordinatorRecordFile(COORD_ID), "utf8")).toBe(corrupt);
	});

	// SAME SCHEMA, WRONG IDENTITY. Every field validates and the record still points
	// at processes this coordinator does not own, so "structurally valid" cannot be
	// the acceptance test — the binding has to be checked as well.
	it("refuses a coordinator record copied from another coordinator", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const foreign = { ...readMultipaneRecord(COORD_ID)!, coordinatorId: "dev3-task-eeeeeeee-0000-0000-0000-000000000009" };
		const text = `${JSON.stringify(foreign, null, 2)}\n`;
		writeFileSync(coordinatorRecordFile(COORD_ID), text);

		await expect(nativePanes.nativeTaskPanesState(TASK_ID)).resolves.toBeNull();
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readFileSync(coordinatorRecordFile(COORD_ID), "utf8")).toBe(text);
	});

	it("refuses a coordinator record binding a pane to a session it does not derive", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const record = readMultipaneRecord(COORD_ID)!;
		// The pane keeps its id, so the layout still agrees with the pane list — only
		// the session it is bound to is one this coordinator would never compute.
		const misbound = {
			...record,
			panes: record.panes.map((pane, index) =>
				index === 1 ? { ...pane, sessionId: `${COORD_ID}-pane-99` } : pane,
			),
		};
		const text = `${JSON.stringify(misbound, null, 2)}\n`;
		writeFileSync(coordinatorRecordFile(COORD_ID), text);

		await expect(nativePanes.nativeTaskPanesState(TASK_ID)).resolves.toBeNull();
		await expect(openAuxPane(columnSpec())).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readFileSync(coordinatorRecordFile(COORD_ID), "utf8")).toBe(text);
	});

	it("refuses a pane record that claims another pane's identity", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const snapshot = readMultipaneRecord(COORD_ID)!;
		const [agentEntry, reviewEntry] = [snapshot.panes[0]!, snapshot.panes[1]!];
		// The agent pane's record, verbatim, dropped into the review pane's directory:
		// current schema, live host, and a shell command belonging to another pane. It
		// would have been classified "owned" and inspected for the wrong command.
		writeFileSync(
			join(sessionDir(reviewEntry.sessionId), "record.json"),
			`${JSON.stringify(paneRecord(agentEntry.sessionId, agentEntry.paneId, ["/bin/zsh"]), null, 2)}\n`,
		);

		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).rejects.toBeInstanceOf(
			PaneOwnershipUnknownError,
		);
		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readMultipaneRecord(COORD_ID)).toEqual(snapshot);

		// And the tolerant read neither shows it nor believes its command.
		const tolerant = await nativePanes.nativeTaskPaneCommands(TASK_ID);
		expect(tolerant.map((pane) => pane.sessionId)).not.toContain(reviewEntry.sessionId);
	});

	// MIXED SET: one owned pane, one provably dead, one unidentifiable. The dead pane
	// must be gone from the layout the caller is handed, not just from the record —
	// otherwise the backend caches a tree that still contains it and the next focus
	// republishes it under the same epoch, undoing the sweep.
	it("cannot resurrect a swept dead pane through a cached layout and a later focus", async () => {
		const { agent, review, third } = writeThreePaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const deadSession = `${COORD_ID}-${third}`;
		rmSync(sessionDir(deadSession), { recursive: true, force: true });
		writeFileSync(join(sessionDir(`${COORD_ID}-${review}`), "record.json"), "{ not json");

		const state = (await nativePanes.nativeTaskPanesState(TASK_ID))!;

		// Swept from the layout the caller gets, not only from the file.
		expect(listPaneIds(restoreSplitTree(state.layout)!)).not.toContain(third);
		expect(listPaneIds(restoreSplitTree(state.layout)!)).toContain(agent);
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.paneId)).not.toContain(third);
		// The unidentifiable pane survives the same sweep, on disk.
		expect(readMultipaneRecord(COORD_ID)!.panes.map((pane) => pane.paneId)).toContain(review);

		// The publish path that used to bring it back: same coordinator, same epoch.
		await nativePanes.focusNativeTaskPane(TASK_ID, agent);

		const after = readMultipaneRecord(COORD_ID)!;
		expect(after.epoch).toBe("epoch-1");
		expect(after.panes.map((pane) => pane.paneId)).not.toContain(third);
		expect(listPaneIds(restoreSplitTree(after.layout)!)).not.toContain(third);
		expect(after.panes.map((pane) => pane.paneId)).toContain(review);
	});

	// CREATION is the most destructive path: it starts a pane and overwrites the
	// coordinator file. Reading a misbound record as "nothing exists" there would
	// leave the foreign live processes orphaned with nothing pointing at them.
	it("refuses to create a pane set over present-but-misbound state, touching nothing", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")]);
		const foreign = { ...readMultipaneRecord(COORD_ID)!, coordinatorId: "dev3-task-eeeeeeee-0000-0000-0000-000000000009" };
		const text = `${JSON.stringify(foreign, null, 2)}\n`;
		writeFileSync(coordinatorRecordFile(COORD_ID), text);
		// Both panes are alive and owned, which is exactly what makes overwriting fatal.
		mocks.classifyOwnership.mockResolvedValue("owned");

		await expect(
			nativePanes.startNativeTaskPanes({
				taskId: TASK_ID,
				cwd: "/tmp/wt",
				env: {},
				launch: { executable: "/bin/zsh", argv: [] },
				cols: 80,
				rows: 24,
			}),
		).rejects.toThrow();

		expect(mocks.registryStart).not.toHaveBeenCalled();
		expect(mocks.registryStop).not.toHaveBeenCalled();
		expect(readFileSync(coordinatorRecordFile(COORD_ID), "utf8")).toBe(text);
	});

	it("treats a genuinely absent pane set as owning nothing, not as undecidable", async () => {
		await expect(findAuxPanes(nativeTask, "columnAgent", SOCKET, { strict: true })).resolves.toEqual([]);
	});

	it("keeps tolerant recovery tolerant for the best-effort purposes", async () => {
		writeTwoPaneSet(["/bin/bash", auxPaneMarker(TASK_ID, "devServer")]);
		writeFileSync(join(sessionDir(reviewPaneSessionId()), "record.json"), "{ not json");

		// devServer deliberately still reads an undecidable pane as "not there".
		await expect(findAuxPanes(nativeTask, "devServer", SOCKET)).resolves.toEqual([]);
	});
});
