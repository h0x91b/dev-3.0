/**
 * The native session's create-vs-reattach race (seq 1292).
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

vi.mock("../native-task-terminal", () => ({
	startNativeTaskTerminal: vi.fn(),
	attachNativeTaskTerminal: vi.fn(),
	nativeTaskTerminalAlive: vi.fn(async () => true),
	stopNativeTaskTerminal: vi.fn(async () => undefined),
}));

import { spawn } from "../spawn";
import { startNativeTaskTerminal, stopNativeTaskTerminal } from "../native-task-terminal";
import {
	createNativeTaskSession,
	destroySessionAwaited,
	getSessionBackend,
	hasDeadSession,
	hasSession,
	isNativeSessionSettling,
} from "../pty-server";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const LAUNCH = { executable: "/bin/zsh", argv: ["/tmp/dev3/run.sh"] };

function fakeTerminal() {
	return {
		sessionId: `dev3-task-${TASK_ID}`,
		hostPid: 10,
		shellPid: 11,
		write: vi.fn(),
		resize: vi.fn(),
		detach: vi.fn(),
	};
}

/** A host boot we can hold open, to observe the window a client could race into. */
function deferredBoot() {
	let settle: (terminal: ReturnType<typeof fakeTerminal>) => void = () => {};
	let fail: (err: Error) => void = () => {};
	const pending = new Promise<ReturnType<typeof fakeTerminal>>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	vi.mocked(startNativeTaskTerminal).mockReturnValue(pending as never);
	return { settle, fail };
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

		boot.settle(fakeTerminal());
		await creating;
		await destroySessionAwaited(TASK_ID);
	});

	it("stops settling once the host is up", async () => {
		const boot = deferredBoot();
		const creating = createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);
		boot.settle(fakeTerminal());
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
		boot.settle(fakeTerminal());
		await creating;
	}

	it("waits for the owned tree and forgets the session", async () => {
		await liveSession();

		await destroySessionAwaited(TASK_ID);

		expect(stopNativeTaskTerminal).toHaveBeenCalledWith(TASK_ID);
		expect(hasSession(TASK_ID)).toBe(false);
	});

	it("surfaces an unconfirmed teardown instead of letting a relaunch race it", async () => {
		await liveSession();
		vi.mocked(stopNativeTaskTerminal).mockRejectedValueOnce(new Error("still present after teardown"));

		await expect(destroySessionAwaited(TASK_ID)).rejects.toThrow(/still present after teardown/);
	});
});
