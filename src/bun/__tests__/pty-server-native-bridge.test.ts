/**
 * The native terminal's viewer bridge over the PTY WebSocket (seq 1300).
 *
 * This is the exact channel remote mode proxies to a browser, so the tests drive
 * the server's real WebSocket handlers (captured from `Bun.serve`) with fake
 * clients instead of asserting on the pure units alone. What must hold: a viewer
 * rebuilds the screen on attach, resumes after a drop without missing or
 * duplicated bytes, and is read-only until it explicitly takes over — while the
 * shell, its siblings, and tmux are never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
	attachNativeTaskTerminal: vi.fn(async () => null),
	nativeTaskTerminalAlive: vi.fn(async () => true),
	stopNativeTaskTerminal: vi.fn(async () => undefined),
}));

import {
	claimMessage,
	decodeNativeStreamMessage,
	releaseMessage,
	type NativeStreamAttachHeader,
	type NativeStreamHeader,
} from "../../shared/native-terminal-stream";
import { encodeResizeSequence } from "../../shared/resize-protocol";
import { startNativeTaskTerminal } from "../native-task-terminal";
import { tmux } from "../tmux";

// The PTY server's WebSocket handlers are the unit under test; `Bun.serve` is a
// stub in this suite, so intercept the config it is handed at module load.
interface WsHandlers {
	open(ws: unknown): void;
	message(ws: unknown, message: string | Uint8Array): void;
	close(ws: unknown): void;
}
let handlers: WsHandlers;
const bun = globalThis as unknown as { Bun: { serve: (config: unknown) => unknown } };
const stubServe = bun.Bun.serve;
bun.Bun.serve = (config: unknown) => {
	const websocket = (config as { websocket?: WsHandlers }).websocket;
	if (websocket) handlers = websocket;
	return stubServe(config);
};

const pty = await import("../pty-server");

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const SESSION_ID = `dev3-task-${TASK_ID}`;
const LAUNCH = { executable: "/bin/zsh", argv: ["/tmp/dev3/run.sh"] };
/** Longer than the 16ms output batch window, so a flush has definitely landed. */
const FLUSH_MS = 40;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ES2020 target: no Array.prototype.at. */
function lastCall<T>(items: T[]): T | undefined {
	return items.length === 0 ? undefined : items[items.length - 1];
}

/** A viewer of the session: what the server sent it, in order. */
class Viewer {
	readonly frames: Array<{ header: NativeStreamHeader; payload: string }> = [];
	readonly raw: string[] = [];
	readonly data: { url: URL };
	closed = false;

	constructor(since?: number) {
		const query = `session=${TASK_ID}${since === undefined ? "" : `&since=${since}`}`;
		this.data = { url: new URL(`http://localhost/?${query}`) };
	}

	sendText(text: string): void {
		if (this.closed) throw new Error("dead client");
		this.raw.push(text);
		const frame = decodeNativeStreamMessage(text);
		if (frame) this.frames.push(frame);
	}

	close(): void {
		this.closed = true;
	}

	get attach(): NativeStreamAttachHeader {
		const frame = this.frames.find((f) => f.header.t === "attach");
		if (!frame) throw new Error("no attach frame received");
		return frame.header as NativeStreamAttachHeader;
	}

	/** Everything this viewer would have written into its terminal, in order. */
	screen(): string {
		return this.frames.map((f) => f.payload).join("");
	}

	roles(): Array<{ role: string; refused: boolean }> {
		return this.frames
			.filter((f) => f.header.t === "role")
			.map((f) => {
				const header = f.header as { role: string; refused?: boolean };
				return { role: header.role, refused: header.refused === true };
			});
	}

	get lastRole(): { role: string; refused: boolean } | undefined {
		return lastCall(this.roles());
	}

	get watermark(): number {
		for (let i = this.frames.length - 1; i >= 0; i--) {
			const header = this.frames[i].header as { seq?: number };
			if (typeof header.seq === "number") return header.seq;
		}
		throw new Error("no watermark received");
	}
}

interface FakeShell {
	write: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	detach: ReturnType<typeof vi.fn>;
	emit: (data: string) => void;
}

function fakeShell(): FakeShell {
	let emit: (data: string) => void = () => {};
	const shell: FakeShell = {
		write: vi.fn(),
		resize: vi.fn(),
		detach: vi.fn(),
		emit: (data) => emit(data),
	};
	vi.mocked(startNativeTaskTerminal).mockImplementation(async (spec) => {
		emit = (data) => spec.onOutput(new TextEncoder().encode(data));
		return {
			sessionId: SESSION_ID,
			paneId: `${SESSION_ID}:0`,
			hostPid: 4242,
			shellPid: 4243,
			write: shell.write,
			resize: shell.resize,
			detach: shell.detach,
		} as unknown as Awaited<ReturnType<typeof startNativeTaskTerminal>>;
	});
	return shell;
}

let shell: FakeShell;
const attached: Viewer[] = [];

/** Connect a viewer through the real open handler. */
function connect(since?: number): Viewer {
	const viewer = new Viewer(since);
	handlers.open(viewer);
	attached.push(viewer);
	return viewer;
}

function disconnect(viewer: Viewer): void {
	handlers.close(viewer);
	viewer.close();
}

beforeEach(async () => {
	vi.clearAllMocks();
	shell = fakeShell();
	await pty.createNativeTaskSession(TASK_ID, "proj-1", "/tmp/wt", LAUNCH);
});

afterEach(async () => {
	for (const viewer of attached.splice(0)) if (!viewer.closed) disconnect(viewer);
	await pty.destroySessionAwaited(TASK_ID);
});

describe("attaching a native viewer", () => {
	it("rebuilds the screen from the journal and reports the session identity", async () => {
		shell.emit("hello from the shell\r\n");
		await delay(FLUSH_MS);

		const desktop = connect();

		expect(desktop.attach).toMatchObject({
			role: "writer",
			resumed: false,
			reset: "fresh",
			sessionId: SESSION_ID,
			paneId: `${SESSION_ID}:0`,
			hostPid: 4242,
			shellPid: 4243,
		});
		expect(desktop.screen()).toBe("hello from the shell\r\n");
	});

	it("replays even output produced with no viewer attached at all", async () => {
		// Remote-only use: the desktop window is closed, the shell keeps working.
		shell.emit("headless output\r\n");
		await delay(FLUSH_MS);

		expect(connect().screen()).toBe("headless output\r\n");
	});

	it("gives a second viewer the same screen and identity, as an observer", async () => {
		shell.emit("shared screen\r\n");
		await delay(FLUSH_MS);
		const desktop = connect();

		const browser = connect();

		expect(browser.attach.role).toBe("observer");
		expect(browser.attach.sessionId).toBe(desktop.attach.sessionId);
		expect(browser.attach.paneId).toBe(desktop.attach.paneId);
		expect(browser.attach.hostPid).toBe(desktop.attach.hostPid);
		expect(browser.attach.shellPid).toBe(desktop.attach.shellPid);
		expect(browser.screen()).toBe(desktop.screen());
	});

	it("attaches to a silent session without claiming to have replayed anything", () => {
		const desktop = connect();

		expect(desktop.attach).toMatchObject({ seq: 0, resumed: false, reset: "fresh" });
		expect(desktop.screen()).toBe("");
	});

	it("streams live output to every viewer with a monotonic watermark", async () => {
		const desktop = connect();
		const browser = connect();

		shell.emit("first\r\n");
		await delay(FLUSH_MS);
		shell.emit("second\r\n");
		await delay(FLUSH_MS);

		expect(desktop.screen()).toBe("first\r\nsecond\r\n");
		expect(browser.screen()).toBe("first\r\nsecond\r\n");
		const seqs = desktop.frames.map((f) => (f.header as { seq: number }).seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(desktop.watermark).toBe(browser.watermark);
	});
});

describe("reconnecting a native viewer", () => {
	it("resumes from its watermark with exactly the frames it missed", async () => {
		const first = connect();
		shell.emit("before-drop\r\n");
		await delay(FLUSH_MS);
		const watermark = first.watermark;

		disconnect(first);
		shell.emit("after-drop\r\n");
		await delay(FLUSH_MS);

		const resumed = connect(watermark);

		expect(resumed.attach).toMatchObject({ resumed: true });
		expect(resumed.screen()).toBe("after-drop\r\n");
	});

	it("sends nothing at all to a viewer that never fell behind", async () => {
		const desktop = connect();
		shell.emit("caught up\r\n");
		await delay(FLUSH_MS);
		const watermark = desktop.watermark;
		disconnect(desktop);

		const resumed = connect(watermark);

		expect(resumed.attach).toMatchObject({ resumed: true, seq: watermark });
		expect(resumed.screen()).toBe("");
	});

	it("keeps the same host, shell, session, and pane identity across the drop", async () => {
		const first = connect();
		shell.emit("x\r\n");
		await delay(FLUSH_MS);
		disconnect(first);

		const second = connect(first.watermark);

		expect(second.attach.sessionId).toBe(first.attach.sessionId);
		expect(second.attach.paneId).toBe(first.attach.paneId);
		expect(second.attach.hostPid).toBe(first.attach.hostPid);
		expect(second.attach.shellPid).toBe(first.attach.shellPid);
		expect(startNativeTaskTerminal).toHaveBeenCalledTimes(1);
	});
});

describe("writer and observer", () => {
	it("passes the writer's keystrokes to the shell", () => {
		const desktop = connect();

		handlers.message(desktop, "ls\r");

		expect(shell.write).toHaveBeenCalledWith("ls\r");
	});

	it("refuses an observer's keystrokes and says so", () => {
		connect();
		const browser = connect();

		handlers.message(browser, "rm -rf /\r");

		expect(shell.write).not.toHaveBeenCalled();
		expect(browser.lastRole).toEqual({ role: "observer", refused: true });
	});

	it("sizes the PTY from the writer alone, so an observer's viewport cannot shrink it", () => {
		const desktop = connect();
		const browser = connect();

		handlers.message(desktop, encodeResizeSequence(200, 50));
		handlers.message(browser, encodeResizeSequence(40, 12));

		expect(shell.resize.mock.calls).toEqual([[200, 50]]);
	});

	it("moves the lease atomically on an explicit takeover", () => {
		const desktop = connect();
		const browser = connect();

		handlers.message(browser, claimMessage());

		expect(browser.lastRole).toEqual({ role: "writer", refused: false });
		expect(desktop.lastRole).toEqual({ role: "observer", refused: false });

		handlers.message(browser, "now mine\r");
		expect(shell.write).toHaveBeenCalledWith("now mine\r");
		handlers.message(desktop, "not any more\r");
		expect(shell.write).toHaveBeenCalledTimes(1);
	});

	it("re-sizes the PTY to the new writer's viewport after a takeover", () => {
		const desktop = connect();
		const browser = connect();
		handlers.message(desktop, encodeResizeSequence(200, 50));
		handlers.message(browser, encodeResizeSequence(80, 24));

		handlers.message(browser, claimMessage());

		expect(lastCall(shell.resize.mock.calls)).toEqual([80, 24]);
	});

	it("hands the lease back on an explicit release", () => {
		const desktop = connect();
		const browser = connect();
		handlers.message(browser, claimMessage());

		handlers.message(browser, releaseMessage());

		expect(desktop.lastRole).toEqual({ role: "writer", refused: false });
		expect(browser.lastRole).toEqual({ role: "observer", refused: false });
	});

	it("promotes a remaining viewer when the writer disconnects, and leaves the shell alive", () => {
		const desktop = connect();
		const browser = connect();

		disconnect(desktop);

		expect(shell.detach).not.toHaveBeenCalled();
		expect(browser.lastRole).toEqual({ role: "writer", refused: false });
		handlers.message(browser, "still here\r");
		expect(shell.write).toHaveBeenCalledWith("still here\r");
	});

	it("keeps the shell running when every viewer disconnects", async () => {
		disconnect(connect());

		expect(shell.detach).not.toHaveBeenCalled();
		shell.emit("still alive\r\n");
		await delay(FLUSH_MS);

		expect(connect().screen()).toBe("still alive\r\n");
	});
});

describe("isolation from tmux", () => {
	it("never reaches for tmux across the whole viewer lifecycle", async () => {
		const killSession = vi.spyOn(tmux, "killSession").mockResolvedValue("" as never);
		const capturePane = vi.spyOn(tmux, "capturePane").mockResolvedValue("" as never);

		const desktop = connect();
		const browser = connect();
		shell.emit("work\r\n");
		await delay(FLUSH_MS);
		handlers.message(browser, claimMessage());
		handlers.message(browser, "input\r");
		handlers.message(browser, encodeResizeSequence(120, 40));
		disconnect(desktop);

		expect(killSession).not.toHaveBeenCalled();
		expect(capturePane).not.toHaveBeenCalled();
		expect(await pty.capturePane(TASK_ID)).toBeNull();
		killSession.mockRestore();
		capturePane.mockRestore();
	});
});
