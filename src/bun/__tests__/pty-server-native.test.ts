/**
 * The native session's create-vs-reattach race (seq 1292/1311).
 *
 * A WebSocket client can connect while the host is still booting. If that
 * connection started a competing reattach, the app would hold TWO clients for one
 * host and could end up with the observer — whose input the host silently drops.
 * So a session under construction reports itself as settling, and a create that
 * fails leaves nothing behind (never a tmux session in its place).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(),
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
		// Shim management must never touch the real ~/.dev3.0/bin of whoever runs this.
		mkdirSync: vi.fn(),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		statSync: vi.fn(() => ({ isFile: () => true })),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((p: string) => p),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

// Mock native-task-panes for the multi-pane lifecycle
vi.mock("../native-task-panes", () => ({
	startNativeTaskPanes: vi.fn(),
	recoverNativeTaskPanes: vi.fn(async () => null),
	stopNativeTaskPanes: vi.fn(async () => undefined),
	nativeTaskPanesAlive: vi.fn(async () => true),
}));

// Mock native-task-terminal for the per-pane binding
vi.mock("../native-task-terminal", () => ({
	bindNativeTaskPane: vi.fn(),
}));

import { spawn } from "../spawn";
import { bindNativeTaskPane } from "../native-task-terminal";
import { startNativeTaskPanes, stopNativeTaskPanes } from "../native-task-panes";
import { tmux } from "../tmux";
import {
	createNativeTaskSession,
	destroyNativeTaskSession,
	destroySessionAwaited,
	getSessionBackend,
	hasDeadSession,
	hasSession,
	isNativeSessionSettling,
} from "../pty-server";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const SIBLING_TASK_ID = "11223344-5555-6666-7777-888888888888";
const LAUNCH = { executable: "/bin/zsh", argv: ["/tmp/dev3/run.sh"] };

function fakePanesState(taskId = TASK_ID) {
	return {
		taskId,
		panes: [{ paneId: "pane-1", sessionId: `dev3-task-${taskId}-pane-1`, hostPid: 10, shellPid: 11, cols: 80, rows: 24, alive: true }],
		layout: "{}",
		activePaneId: "pane-1",
	};
}

function fakeTerminal(taskId = TASK_ID) {
	return {
		sessionId: `dev3-task-${taskId}-pane-1`,
		paneId: "pane-1",
		hostPid: 10,
		shellPid: 11,
		write: vi.fn(),
		resize: vi.fn(),
		detach: vi.fn(),
	};
}

/** A host boot we can hold open, to observe the window a client could race into. */
function deferredBoot(taskId = TASK_ID) {
	let settlePanes: (state: ReturnType<typeof fakePanesState>) => void = () => {};
	let fail: (err: Error) => void = () => {};
	const pendingPanes = new Promise<ReturnType<typeof fakePanesState>>((resolve, reject) => {
		settlePanes = resolve;
		fail = reject;
	});
	vi.mocked(startNativeTaskPanes).mockReturnValue(pendingPanes as never);
	vi.mocked(bindNativeTaskPane).mockResolvedValue(fakeTerminal(taskId) as never);
	return { settlePanes: (state = fakePanesState(taskId)) => settlePanes(state), fail };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createNativeTaskSession — the boot window", () => {
	it("reports the session as settling, and not dead, while the host boots", async () => {
		const boot = deferredBoot();

		const creating = createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);

		expect(hasSession(TASK_ID)).toBe(true);
		expect(isNativeSessionSettling(TASK_ID)).toBe(true);
		expect(hasDeadSession(TASK_ID)).toBe(false);

		boot.settlePanes();
		await creating;
		await destroySessionAwaited(TASK_ID);
	});

	it("stops settling once the host is up", async () => {
		const boot = deferredBoot();
		const creating = createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);
		boot.settlePanes();
		await creating;

		expect(isNativeSessionSettling(TASK_ID)).toBe(false);
		expect(hasDeadSession(TASK_ID)).toBe(false);
		expect(getSessionBackend(TASK_ID)).toBe("native");

		await destroySessionAwaited(TASK_ID);
	});

	it("leaves nothing behind — and no tmux — when the host never comes up", async () => {
		const boot = deferredBoot();
		const creating = createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);
		boot.fail(new Error("no native host runtime"));

		await expect(creating).rejects.toThrow(/no native host runtime/);
		expect(hasSession(TASK_ID)).toBe(false);
		expect(isNativeSessionSettling(TASK_ID)).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("destroySessionAwaited on a native session", () => {
	async function liveSession(): Promise<void> {
		const boot = deferredBoot();
		const creating = createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);
		boot.settlePanes();
		await creating;
	}

	it("waits for the owned tree and forgets the session", async () => {
		await liveSession();

		await destroySessionAwaited(TASK_ID);

		expect(stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
		expect(hasSession(TASK_ID)).toBe(false);
	});

	it("surfaces an unconfirmed teardown instead of letting a relaunch race it", async () => {
		await liveSession();
		vi.mocked(stopNativeTaskPanes).mockRejectedValueOnce(new Error("still present after teardown"));

		await expect(destroySessionAwaited(TASK_ID)).rejects.toThrow(/still present after teardown/);
	});
});

/**
 * The lifecycle teardown primitive (seq 1298): the cleanup script and the worktree
 * removal run after it, so it may only resolve once the owned tree is verified gone
 * — attached or not — and it must leave every other session alone.
 */
describe("destroyNativeTaskSession", () => {
	async function liveSession(taskId: string): Promise<ReturnType<typeof fakeTerminal>> {
		const terminal = fakeTerminal(taskId);
		const boot = deferredBoot(taskId);
		const creating = createNativeTaskSession(taskId, "proj-1", "/tmp/wt", LAUNCH);
		boot.settlePanes(fakePanesState(taskId));
		vi.mocked(bindNativeTaskPane).mockResolvedValue(terminal as never);
		await creating;
		return terminal;
	}

	it("releases the attached client and then waits for the owned tree", async () => {
		const terminal = await liveSession(TASK_ID);

		await destroyNativeTaskSession(TASK_ID);

		expect(terminal.detach).toHaveBeenCalledTimes(1);
		expect(stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
		expect(hasSession(TASK_ID)).toBe(false);
	});

	it("stops an unattached tree after an app restart, without spawning anything", async () => {
		expect(hasSession(TASK_ID)).toBe(false);

		await destroyNativeTaskSession(TASK_ID);

		expect(stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
		expect(startNativeTaskPanes).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("stays an idempotent success when repeated on an already-stopped task", async () => {
		await liveSession(TASK_ID);

		await destroyNativeTaskSession(TASK_ID);
		await expect(destroyNativeTaskSession(TASK_ID)).resolves.toBeUndefined();

		expect(stopNativeTaskPanes).toHaveBeenCalledTimes(2);
		expect(startNativeTaskPanes).toHaveBeenCalledTimes(1);
	});

	it("propagates an unconfirmed teardown so the lifecycle can hold off cleanup", async () => {
		await liveSession(TASK_ID);
		vi.mocked(stopNativeTaskPanes).mockRejectedValueOnce(new Error("still present after teardown"));

		await expect(destroyNativeTaskSession(TASK_ID)).rejects.toThrow(/still present after teardown/);
	});

	it("leaves a sibling native session alone and never reaches for tmux", async () => {
		const sibling = await liveSession(SIBLING_TASK_ID);
		await liveSession(TASK_ID);
		const killSession = vi.spyOn(tmux, "killSession").mockResolvedValue("" as never);

		await destroyNativeTaskSession(TASK_ID);

		expect(hasSession(SIBLING_TASK_ID)).toBe(true);
		expect(sibling.detach).not.toHaveBeenCalled();
		expect(vi.mocked(stopNativeTaskPanes).mock.calls).toEqual([[TASK_ID]]);
		expect(killSession).not.toHaveBeenCalled();

		await destroyNativeTaskSession(SIBLING_TASK_ID);
		killSession.mockRestore();
	});
});
