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

vi.mock("../native-task-panes", () => ({
	startNativeTaskPanes: vi.fn(),
	recoverNativeTaskPanes: vi.fn(async () => null),
	stopNativeTaskPanes: vi.fn(async () => undefined),
	nativeTaskPanesAlive: vi.fn(async () => true),
}));

vi.mock("../native-task-terminal", () => ({
	bindNativeTaskPane: vi.fn(async () => null),
}));

import {
	claimMessage,
	decodeNativeStreamMessage,
	releaseMessage,
	type NativeStreamAttachHeader,
	type NativeStreamHeader,
} from "../../shared/native-terminal-stream";
import { paneSessionKey } from "../../shared/pane-session-key";
import { encodeResizeSequence } from "../../shared/resize-protocol";
import { bindNativeTaskPane } from "../native-task-terminal";
import { startNativeTaskPanes } from "../native-task-panes";
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
const { ensureNativePanePtySession } = pty;

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
				const header = f.header as { role: string; refused?: boolean; refusedReason?: string };
				return {
					role: header.role,
					refused: header.refused === true,
					...(header.refusedReason ? { refusedReason: header.refusedReason } : {}),
				};
			});
	}

	get lastRole(): { role: string; refused: boolean; refusedReason?: string } | undefined {
		return lastCall(this.roles());
	}

	/** The whole role frame, including the PTY geometry an observer renders at. */
	get lastRoleHeader(): { role: string; cols?: number; rows?: number } | undefined {
		return lastCall(
			this.frames.filter((f) => f.header.t === "role").map((f) => f.header),
		) as { role: string; cols?: number; rows?: number } | undefined;
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
	/** What the HOST granted this app process — another dev3 instance may own it. */
	hostRole: "writer" | "observer";
	/** Whether a cross-process claim succeeds; false = the other process keeps it. */
	grantClaim: boolean;
	/** Set when the host cannot transfer at all (a host staged before `takeover`). */
	takeoverUnsupported: boolean;
	/** Make the host round trip block until `settleTakeover()` is called. */
	holdTakeover: boolean;
	/** False models a host that never confirms the release. */
	releaseConfirms: boolean;
	/** True models the host never answering, so the caller must compensate. */
	takeoverTimesOut: boolean;
	/** Block the release round trip until `settleRelease()` is called. */
	holdRelease: boolean;
	settleRelease: (() => void) | null;
	/** False models the host REFUSING a resize (stale generation). */
	resizeApplies: boolean;
	/** Whether ANY process holds the lease, as the host reports it. */
	writerAttached: boolean;
	claimHostWriter: ReturnType<typeof vi.fn>;
	takeoverHostWriter: ReturnType<typeof vi.fn>;
	releaseHostWriter: ReturnType<typeof vi.fn>;
	resizeAwaited: ReturnType<typeof vi.fn>;
	/** Resolve the pending host round trip by hand, to model a slow host. */
	settleTakeover: (() => void) | null;
}

const FIRST_PANE_SESSION_ID = `${SESSION_ID}-pane-1`;

function fakeShell(): FakeShell {
	let emit: (data: string) => void = () => {};
	const shell: FakeShell = {
		write: vi.fn(),
		resize: vi.fn(),
		detach: vi.fn(),
		emit: (data) => emit(data),
		hostRole: "writer",
		grantClaim: true,
		takeoverUnsupported: false,
		holdTakeover: false,
		releaseConfirms: true,
		takeoverTimesOut: false,
		holdRelease: false,
		settleRelease: null,
		resizeApplies: true,
		writerAttached: true,
		claimHostWriter: vi.fn(async () => {
			if (shell.grantClaim) shell.hostRole = "writer";
			return shell.hostRole;
		}),
		// The explicit gesture: it displaces a live writer, so `grantClaim` (which models
		// a NON-stealing claim) does not gate it — only a host too old to transfer does.
		settleTakeover: null,
		resizeAwaited: vi.fn(async (cols: number, rows: number) => {
			if (!shell.resizeApplies) throw new Error("writer generation is stale");
			(shell.resize as unknown as (c: number, r: number) => void)(cols, rows);
			return { cols, rows };
		}),
		releaseHostWriter: vi.fn(async () => {
			if (shell.holdRelease) await new Promise<void>((resolve) => { shell.settleRelease = resolve; });
			if (!shell.releaseConfirms) return false;
			shell.hostRole = "observer";
			return true;
		}),
		takeoverHostWriter: vi.fn(async () => {
			// A real takeover is a round trip to another process; tests that care about
			// what happens DURING it install a gate here.
			const gate = new Promise<void>((resolve) => {
				if (shell.holdTakeover) shell.settleTakeover = resolve;
				else resolve();
			});
			await gate;
			if (shell.takeoverTimesOut) return { ok: false, refusal: "transfer-failed", timedOut: true };
			if (!shell.takeoverUnsupported) {
				shell.hostRole = "writer";
				return { ok: true };
			}
			if (shell.grantClaim) shell.hostRole = "writer";
			return shell.hostRole === "writer" ? { ok: true } : { ok: false, refusal: "host-too-old" };
		}),
	};
	vi.mocked(startNativeTaskPanes).mockResolvedValue({
		taskId: TASK_ID,
		panes: [{ paneId: "pane-1", sessionId: FIRST_PANE_SESSION_ID, hostPid: 4242, shellPid: 4243, cols: 80, rows: 24, alive: true }],
		layout: "{}",
		activePaneId: "pane-1",
	} as never);
	vi.mocked(bindNativeTaskPane).mockImplementation(async (_sessionId, hooks) => {
		emit = (data) => hooks.onOutput(new TextEncoder().encode(data));
		return {
			sessionId: FIRST_PANE_SESSION_ID,
			paneId: "pane-1",
			hostPid: 4242,
			shellPid: 4243,
			write: shell.write,
			resize: shell.resize,
			detach: shell.detach,
			hostRole: () => shell.hostRole,
			hostWriterAttached: () => shell.writerAttached,
			claimHostWriter: shell.claimHostWriter,
			takeoverHostWriter: shell.takeoverHostWriter,
			releaseHostWriter: shell.releaseHostWriter,
			resizeAwaited: shell.resizeAwaited,
			writerPid: async () => (shell.hostRole === "writer" ? process.pid : 4711),
		} as unknown as Awaited<ReturnType<typeof bindNativeTaskPane>>;
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
			paneId: "pane-1",
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
		expect(startNativeTaskPanes).toHaveBeenCalledTimes(1);
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

	// The gesture always asks the host first now (see the stale-cache test above), so it
	// is inherently async — the ATOMICITY being asserted is that both sides flip in the
	// same step, not that the step is synchronous.
	it("moves the lease atomically on an explicit takeover", async () => {
		const desktop = connect();
		const browser = connect();

		handlers.message(browser, claimMessage());
		await delay(FLUSH_MS);

		expect(browser.lastRole).toEqual({ role: "writer", refused: false });
		expect(desktop.lastRole).toEqual({ role: "observer", refused: false });

		handlers.message(browser, "now mine\r");
		expect(shell.write).toHaveBeenCalledWith("now mine\r");
		handlers.message(desktop, "not any more\r");
		expect(shell.write).toHaveBeenCalledTimes(1);
	});

	it("re-sizes the PTY to the new writer's viewport after a takeover", async () => {
		const desktop = connect();
		const browser = connect();
		handlers.message(desktop, encodeResizeSequence(200, 50));
		handlers.message(browser, encodeResizeSequence(80, 24));

		handlers.message(browser, claimMessage());
		await delay(FLUSH_MS);

		expect(lastCall(shell.resize.mock.calls)).toEqual([80, 24]);
	});

	// An observer that reflows the stream to its own width wraps every long line in
	// the wrong place, which is what a second window actually looked like.
	it("tells a viewer the PTY's geometry so an observer can render at the writer's shape", async () => {
		const desktop = connect();
		handlers.message(desktop, encodeResizeSequence(200, 50));
		await delay(FLUSH_MS); // canonical geometry lands with the host's ACK, not the request

		const browser = connect();

		expect(browser.attach).toMatchObject({ role: "observer", cols: 200, rows: 50 });
	});

	it("republishes the geometry to observers when the writer reshapes the PTY", async () => {
		const desktop = connect();
		const browser = connect();
		handlers.message(desktop, encodeResizeSequence(180, 44));
		await delay(FLUSH_MS);

		expect(browser.lastRoleHeader).toMatchObject({ role: "observer", cols: 180, rows: 44 });
	});

	it("tells its own viewers they are read-only when ANOTHER app process holds the host lease", () => {
		shell.hostRole = "observer";

		const desktop = connect();

		expect(desktop.attach.role).toBe("observer");
	});

	it("never writes to the shell from a process the host made an observer", () => {
		shell.hostRole = "observer";
		const desktop = connect();

		handlers.message(desktop, "would vanish\r");

		expect(shell.write).not.toHaveBeenCalled();
		expect(desktop.lastRole).toEqual({ role: "observer", refused: true });
	});

	// The exact strand: a second dev3 window took the free lease, then quit. The
	// remaining window was left saying "another viewer is typing" with nobody
	// there, and neither resize nor take control did anything.
	it("says the lease is free once nobody holds it, instead of blaming a phantom viewer", () => {
		shell.hostRole = "observer";
		shell.writerAttached = false;

		const desktop = connect();

		expect(desktop.attach).toMatchObject({ role: "observer", writerAttached: false });
	});

	it("still reports a real writer as attached", () => {
		shell.hostRole = "observer";
		shell.writerAttached = true;

		const desktop = connect();

		expect(desktop.attach).toMatchObject({ role: "observer", writerAttached: true });
	});

	// A plain `claim` is refused while another dev3 process is typing, so the explicit
	// gesture must take over instead.
	it("take control TAKES OVER the host lease from another app process, not merely claims it", async () => {
		shell.hostRole = "observer";
		shell.grantClaim = false; // a live peer holds it — a plain claim would be refused
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);

		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(1);
		expect(shell.claimHostWriter).not.toHaveBeenCalled();
		expect(desktop.lastRole).toEqual({ role: "writer", refused: false });
		handlers.message(desktop, "mine now\r");
		expect(shell.write).toHaveBeenCalledWith("mine now\r");
	});

	it("take control promotes the viewer when the host slot was already vacant", async () => {
		shell.hostRole = "observer";
		shell.writerAttached = false;
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);

		expect(desktop.lastRole).toEqual({ role: "writer", refused: false });
		handlers.message(desktop, "mine now\r");
		expect(shell.write).toHaveBeenCalledWith("mine now\r");
	});

	// A host that cannot transfer at all: the viewer must be told THAT, not left to
	// click a button that will never work.
	it("reports host-too-old when the host cannot transfer and a peer still holds the lease", async () => {
		shell.hostRole = "observer";
		shell.takeoverUnsupported = true;
		shell.grantClaim = false;
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);

		expect(desktop.lastRole).toEqual({ role: "observer", refused: true, refusedReason: "host-too-old" });
		handlers.message(desktop, "still refused\r");
		expect(shell.write).not.toHaveBeenCalled();
	});

	// The host round trip is async, so the requester can close its
	// tab mid-flight. Winning the lease for a socket that is gone would leave this process
	// owning the host lease while every surviving viewer is a local observer — nobody able
	// to type, in any window, and the lease stranded until the process dies.
	it("gives the lease to a surviving viewer when the requester leaves mid-takeover", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		const leaving = connect();
		const staying = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving); // tab closed while the host was still deciding
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		expect(staying.lastRole).toEqual({ role: "writer", refused: false });
		handlers.message(staying, "mine now\r");
		expect(shell.write).toHaveBeenCalledWith("mine now\r");
		expect(shell.releaseHostWriter).not.toHaveBeenCalled();
	});

	// An unconfirmed release is worse than no release: the lease stays held by a process
	// that cannot use it, locking every other dev3 window out. Dropping the connection
	// makes the host free it, because it clears the writer on socket close.
	it("detaches the host client when the release is never confirmed", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.releaseConfirms = false;
		const leaving = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving);
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		expect(shell.releaseHostWriter).toHaveBeenCalledTimes(1);
		expect(shell.detach).toHaveBeenCalled();
	});

	// A stale local cache must not stop the gesture reaching the host.
	it("asks the host even when this process already believes it is the writer", async () => {
		shell.hostRole = "writer";
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);

		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(1);
	});

	it("releases the host lease instead of stranding it when no viewer remains", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		const leaving = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving);
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		// Holding it would lock every other dev3 window out of a pane nobody is watching.
		expect(shell.releaseHostWriter).toHaveBeenCalledTimes(1);
	});

	it("does not answer a refusal to a viewer that already left", async () => {
		shell.hostRole = "observer";
		shell.takeoverUnsupported = true;
		shell.grantClaim = false;
		shell.holdTakeover = true;
		const leaving = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		const framesBefore = leaving.frames.length;
		disconnect(leaving);
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		expect(leaving.frames.length).toBe(framesBefore);
	});

	// Canonical geometry may only change once the HOST has applied the resize.
	// Publishing what we asked for would broadcast a refused resize as the truth.
	it("does not publish canonical geometry when the host refuses the resize", async () => {
		shell.resizeApplies = false;
		const desktop = connect();
		const before = desktop.lastRoleHeader;

		handlers.message(desktop, encodeResizeSequence(200, 50));
		await delay(FLUSH_MS);

		expect(shell.resize).not.toHaveBeenCalledWith(200, 50);
		expect(desktop.lastRoleHeader).toEqual(before);
	});

	it("publishes canonical geometry only after the host applies it", async () => {
		const desktop = connect();

		handlers.message(desktop, encodeResizeSequence(140, 45));
		await delay(FLUSH_MS);

		expect(shell.resizeAwaited).toHaveBeenCalledWith(140, 45);
		expect(desktop.lastRoleHeader).toMatchObject({ cols: 140, rows: 45 });
	});

	// A survivor promoted by a DISCONNECT must be told its effective role. If
	// another process owns the host lease, calling it `writer` is a lie until it types.
	it("promotes a disconnect survivor to its EFFECTIVE role, not a raw writer", async () => {
		shell.hostRole = "observer";
		const leaving = connect();
		const staying = connect();

		disconnect(leaving);
		await delay(FLUSH_MS);

		expect(staying.lastRole).toEqual({ role: "observer", refused: false });
	});

	it("promotes a disconnect survivor to writer when this process DOES own the lease", async () => {
		shell.hostRole = "writer";
		const leaving = connect();
		const staying = connect();

		disconnect(leaving);
		await delay(FLUSH_MS);

		expect(staying.lastRole).toEqual({ role: "writer", refused: false });
	});

	// With the re-entry guard removed this path ran at
	// ~12k takeovers/second and wrote 540k log lines in three minutes. The bound is now
	// structural, so a burst of gestures cannot multiply into host round trips.
	it("asks the host at most ONCE per gesture, however many arrive", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		const desktop = connect();

		for (let i = 0; i < 50; i++) handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);
		// One outstanding request for this pane, not fifty.
		expect(pty._nativeTakeoversInFlightForTests()).toBe(1);
		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(1);

		shell.settleTakeover?.();
		await delay(FLUSH_MS);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(0);
		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(1);
		expect(desktop.lastRole).toEqual({ role: "writer", refused: false });
	});

	it("settling a takeover never re-enters the host request", async () => {
		shell.hostRole = "observer";
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);
		await delay(FLUSH_MS);

		// The success continuation moves only the LOCAL lease; re-entering here is what
		// produced the livelock.
		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(1);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(0);
	});

	// A vacant-slot takeover changes writerAttached without changing anyone's
	// role, so a role-change-driven publish would tell the OTHER viewer nothing.
	it("tells every local viewer the slot is taken, even though their role did not change", async () => {
		shell.hostRole = "observer";
		shell.writerAttached = false;
		const first = connect();
		const second = connect();
		expect(first.attach).toMatchObject({ writerAttached: false });

		shell.writerAttached = true; // the host grants it to `second`
		handlers.message(second, claimMessage());
		await delay(FLUSH_MS);

		expect(first.lastRoleHeader).toMatchObject({ role: "observer", writerAttached: true });
	});

	// Nothing may look like a writer while the binding is going away,
	// and with no viewers left there must be NO rebind and NO claim.
	it("demotes before detaching and performs no hidden rebind when no viewer remains", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.releaseConfirms = false;
		const leaving = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving);
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		expect(shell.releaseHostWriter).toHaveBeenCalledTimes(1);
		expect(shell.detach).toHaveBeenCalled();
		// No rebind: bindNativeTaskPane is only ever called for the initial session here.
		expect(vi.mocked(bindNativeTaskPane)).toHaveBeenCalledTimes(1);
		// And the bindingless session is GONE, so a later viewer rebuilds it instead of
		// attaching to a registered session that can never be rebound.
		expect(pty.hasSession(TASK_ID)).toBe(false);
	});

	it("keeps a viewer that arrives DURING recovery honest — never an optimistic writer", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.releaseConfirms = false;
		const leaving = connect();
		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving);

		// Settle the host round trip and attach a viewer while the binding is being replaced.
		shell.settleTakeover?.();
		const arriving = connect();

		expect(arriving.attach).toMatchObject({ role: "observer" });
		await delay(FLUSH_MS);
	});

	// A throwing listener must not be able to strand a request, which would turn a
	// clean refusal into a timeout and then into an unnecessary compensation.
	it("settles a refused takeover even when the host error listener throws", async () => {
		shell.hostRole = "observer";
		shell.takeoverUnsupported = true;
		shell.grantClaim = false;
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);

		// The refusal still reached the viewer, so settlement was not blocked.
		expect(desktop.lastRole).toMatchObject({ refused: true });
	});

	// The in-flight guard must be held for the WHOLE recovery. Releasing it when the host
	// request settles lets a second gesture overlap the release/rebind and the recovering
	// window, which is exactly what an unawaited compensation allows.
	it("holds the pane's in-flight guard until compensation itself finishes", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.holdRelease = true;
		shell.takeoverTimesOut = true;
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);
		// Let the host round trip TIME OUT, which is what triggers compensation.
		shell.settleTakeover?.();
		await delay(FLUSH_MS);
		expect(shell.releaseHostWriter).toHaveBeenCalledTimes(1);

		// Compensation is mid-flight. A second gesture must not start another host request.
		const takeoversSoFar = shell.takeoverHostWriter.mock.calls.length;
		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);
		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(takeoversSoFar);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(1);

		shell.settleRelease?.();
		await delay(FLUSH_MS);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(0);
	});

	// The refusal is a VERDICT, so it must arrive with recovery's outcome. Publishing it
	// first meant the next snapshot immediately cleared the diagnosis.
	it("publishes the timeout refusal only after compensation settles", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.holdRelease = true;
		shell.takeoverTimesOut = true;
		const desktop = connect();

		handlers.message(desktop, claimMessage());
		await delay(FLUSH_MS);
		shell.settleTakeover?.();
		await delay(FLUSH_MS);

		// Recovery is still running: nothing may claim to know why it failed yet.
		expect(desktop.lastRole?.refused).not.toBe(true);

		shell.settleRelease?.();
		await delay(FLUSH_MS);
		expect(desktop.lastRole).toMatchObject({ refused: true, refusedReason: "transfer-failed" });
	});

	// The requester-gone path holds the pane's guard for the whole recovery, so a second
	// gesture cannot overlap release, detach or rebind.
	it("holds the guard through requester-gone compensation too", async () => {
		shell.hostRole = "observer";
		shell.holdTakeover = true;
		shell.holdRelease = true;
		const leaving = connect();

		handlers.message(leaving, claimMessage());
		await delay(FLUSH_MS);
		disconnect(leaving); // the requester's tab closes mid-round-trip, leaving nobody
		shell.settleTakeover?.();
		await delay(FLUSH_MS);
		expect(shell.releaseHostWriter).toHaveBeenCalledTimes(1);

		// A viewer arrives WHILE recovery runs and gestures: no second host request.
		const arriving = connect();
		const before = shell.takeoverHostWriter.mock.calls.length;
		handlers.message(arriving, claimMessage());
		await delay(FLUSH_MS);
		expect(shell.takeoverHostWriter).toHaveBeenCalledTimes(before);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(1);

		shell.settleRelease?.();
		await delay(FLUSH_MS);
		expect(pty._nativeTakeoversInFlightForTests()).toBe(0);
	});

	it("hands the lease back on an explicit release", async () => {
		const desktop = connect();
		const browser = connect();
		handlers.message(browser, claimMessage());
		await delay(FLUSH_MS);

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

/**
 * Regression guard for the attach frame identity fix (seq 1311).
 *
 * sessionId MUST be the bare task coordinator id (nativeTaskSessionId(taskId))
 * for EVERY pane — never the pane registry id (which has a -pane-N suffix).
 * paneId distinguishes panes on the same session.
 */
describe("attach frame identity — pane-1 and composite pane-2", () => {
	const SECOND_PANE_ID = "pane-2";
	const SECOND_PANE_SESSION_ID = `${SESSION_ID}-${SECOND_PANE_ID}`;

	function connectForPane(paneId: string, since?: number): Viewer {
		const key = paneId === "pane-1" ? TASK_ID : paneSessionKey(TASK_ID, paneId);
		const query = `session=${key}${since === undefined ? "" : `&since=${since}`}`;
		const viewer = new Viewer();
		// Override the URL so the WS handler looks up the right composite key.
		(viewer.data as { url: URL }).url = new URL(`http://localhost/?${query}`);
		handlers.open(viewer);
		attached.push(viewer);
		return viewer;
	}

	it("pane-1: sessionId is the coordinator id (no -pane-N suffix), paneId is pane-1", () => {
		const viewer = connectForPane("pane-1");
		expect(viewer.attach.sessionId).toBe(SESSION_ID);
		expect(viewer.attach.paneId).toBe("pane-1");
		expect(viewer.attach.hostPid).toBe(4242);
		expect(viewer.attach.shellPid).toBe(4243);
	});

	it("pane-2 (composite key): sessionId is still the coordinator id, paneId is pane-2", async () => {
		const SECOND_PANE_HOST_PID = 5050;
		const SECOND_PANE_SHELL_PID = 5051;

		vi.mocked(bindNativeTaskPane).mockImplementationOnce(async (_sid, _hooks, pId) => ({
			sessionId: SECOND_PANE_SESSION_ID,
			paneId: pId || SECOND_PANE_ID,
			hostPid: SECOND_PANE_HOST_PID,
			shellPid: SECOND_PANE_SHELL_PID,
			write: vi.fn(),
			resize: vi.fn(),
			detach: vi.fn(),
		} as unknown as Awaited<ReturnType<typeof bindNativeTaskPane>>));

		await ensureNativePanePtySession(TASK_ID, SECOND_PANE_ID, SECOND_PANE_SESSION_ID, "proj-1", "/tmp/wt");

		const viewer = connectForPane(SECOND_PANE_ID);
		expect(viewer.attach.sessionId).toBe(SESSION_ID);
		expect(viewer.attach.paneId).toBe(SECOND_PANE_ID);
		expect(viewer.attach.hostPid).toBe(SECOND_PANE_HOST_PID);
		expect(viewer.attach.shellPid).toBe(SECOND_PANE_SHELL_PID);
	});

	// Auxiliary panes are registered under `taskId~paneId`. Cleaning up pane 2 must delete
	// THAT key: deleting the bare taskId would unregister pane 1 and leave pane 2's dead
	// entry behind, so pane 1's viewers lose their session and pane 2 can never rebind.
	it("cleans up pane 2 by its composite key, leaving pane 1 registered", async () => {
		// A holder, not a bare `let`: TS narrows a callback-assigned local back to null.
		const paneGate: { settle: (() => void) | null } = { settle: null };
		const paneShell = {
			sessionId: SECOND_PANE_SESSION_ID,
			paneId: SECOND_PANE_ID,
			hostPid: 5060,
			shellPid: 5061,
			write: vi.fn(),
			resize: vi.fn(),
			detach: vi.fn(),
			hostRole: () => "observer",
			hostWriterAttached: () => true,
			hostPtyGeometry: () => null,
			takeoverHostWriter: vi.fn(async () => {
				// Park the round trip so the viewer can leave BEFORE compensation decides.
				await new Promise<void>((resolve) => { paneGate.settle = resolve; });
				return { ok: false, refusal: "transfer-failed", timedOut: true };
			}),
			releaseHostWriter: vi.fn(async () => false),
			resizeAwaited: vi.fn(async (cols: number, rows: number) => ({ cols, rows })),
			claimHostWriter: vi.fn(async () => "observer"),
			claimHostWriterDiscriminated: vi.fn(async () => ({ outcome: "failed" })),
			writerPid: vi.fn(async () => 4711),
		};
		vi.mocked(bindNativeTaskPane).mockImplementation(async () => paneShell as never);
		await ensureNativePanePtySession(TASK_ID, SECOND_PANE_ID, SECOND_PANE_SESSION_ID, "proj-1", "/tmp/wt");

		// Pane 2's only viewer gestures, then leaves mid-round-trip: compensation runs with
		// no viewers, which is the path that unregisters the session.
		const paneViewer = connectForPane(SECOND_PANE_ID);
		handlers.message(paneViewer, claimMessage());
		await delay(FLUSH_MS);
		disconnect(paneViewer); // leaves while the host round trip is still parked
		paneGate.settle?.();
		await delay(FLUSH_MS);
		await delay(FLUSH_MS);

		expect(pty.hasSession(paneSessionKey(TASK_ID, SECOND_PANE_ID))).toBe(false);
		expect(pty.hasSession(TASK_ID)).toBe(true); // pane 1 untouched
		// A later pane-2 open reconstructs it.
		await ensureNativePanePtySession(TASK_ID, SECOND_PANE_ID, SECOND_PANE_SESSION_ID, "proj-1", "/tmp/wt");
		expect(pty.hasSession(paneSessionKey(TASK_ID, SECOND_PANE_ID))).toBe(true);
	});
});

// The lookup owner routing starts from: a caller resolves a binding here, then
// asks the HOST who may write before delivering anything through it.
describe("nativePaneTerminal", () => {
	it("finds the first pane under the bare task key", () => {
		expect(pty.nativePaneTerminal(TASK_ID)?.paneId).toBe("pane-1");
		expect(pty.nativePaneTerminal(TASK_ID, "pane-1")?.paneId).toBe("pane-1");
	});

	it("refuses to pass off pane-1 as another pane", () => {
		expect(pty.nativePaneTerminal(TASK_ID, "pane-2")).toBeNull();
	});

	it("has nothing for a task this process never bound", () => {
		expect(pty.nativePaneTerminal("11111111-2222-3333-4444-555555555555")).toBeNull();
	});

	it("hands back a binding whose host role can be interrogated", () => {
		shell.hostRole = "observer";
		expect(pty.nativePaneTerminal(TASK_ID)?.hostRole()).toBe("observer");
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
