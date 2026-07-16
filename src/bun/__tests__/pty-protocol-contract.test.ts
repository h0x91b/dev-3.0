/** Direct contract tests for the internal PTY WebSocket consumed by the remote proxy. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		existsSync: vi.fn(() => false),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((path: string) => path),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-pty-contract" }));
vi.mock("../tmux-themes", () => ({
	CATPPUCCIN_PLUGIN_DIR: "/tmp/dev3-pty-contract/theme",
	writeCatppuccinPlugin: vi.fn(),
}));
vi.mock("../shell-init", () => ({ writeShellInit: vi.fn() }));
vi.mock("../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/bash") }));
vi.mock("../executable", () => ({ isExecutableFile: vi.fn(() => true) }));

const terminal = {
	close: vi.fn(),
	resize: vi.fn(),
	write: vi.fn(),
};
let outputCallback: ((terminal: unknown, data: string | Uint8Array) => void) | undefined;

vi.mock("../spawn", () => ({
	spawn: vi.fn((_args: unknown, options?: { terminal?: { data?: typeof outputCallback } }) => {
		if (options?.terminal?.data) outputCallback = options.terminal.data;
		return {
			pid: 123,
			terminal,
			kill: vi.fn(),
			exited: new Promise<number>(() => {}),
			stdin: { write: vi.fn(), end: vi.fn() },
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
		};
	}),
	spawnSync: vi.fn(() => ({ exitCode: 0, stdout: new Uint8Array() })),
}));

type PtyServeOptions = {
	websocket: {
		open(ws: FakePtySocket): void;
		message(ws: FakePtySocket, data: string | Uint8Array): void;
		close(ws: FakePtySocket): void;
	};
};

type FakePtySocket = {
	data: { url: URL };
	close: ReturnType<typeof vi.fn>;
	sendText: ReturnType<typeof vi.fn>;
	sessionId?: string;
	ptyCols?: number;
	ptyRows?: number;
};

type PtyModule = typeof import("../pty-server");
let pty: PtyModule;
let serveOptions: PtyServeOptions;
let originalServe: typeof Bun.serve;
const createdSessions = new Set<string>();

function socket(url: string): FakePtySocket {
	return { data: { url: new URL(url) }, close: vi.fn(), sendText: vi.fn() };
}

function create(sessionId: string) {
	createdSessions.add(sessionId);
	pty.createSession(sessionId, "project-1", "/tmp/worktree", "/bin/bash");
}

beforeAll(async () => {
	originalServe = Bun.serve;
	(Bun as any).serve = vi.fn((options: PtyServeOptions) => {
		serveOptions = options;
		return { port: 45678 };
	});
	pty = await import("../pty-server");
});

afterEach(() => {
	for (const sessionId of createdSessions) {
		if (pty.hasSession(sessionId)) pty.destroySession(sessionId);
	}
	createdSessions.clear();
	terminal.close.mockClear();
	terminal.resize.mockClear();
	terminal.write.mockClear();
	outputCallback = undefined;
	pty.setOnOsc52Copy(() => {});
});

afterAll(() => {
	(Bun as any).serve = originalServe;
});

describe("PTY session and close contract", () => {
	it("closes direct connections without a session as 4000", () => {
		const ws = socket("ws://localhost/");
		serveOptions.websocket.open(ws);
		expect(ws.close).toHaveBeenCalledWith(4000, "Missing session parameter");
	});

	it("closes direct connections to an unknown session as 4001", () => {
		const ws = socket("ws://localhost/?session=unknown-task");
		serveOptions.websocket.open(ws);
		expect(ws.close).toHaveBeenCalledWith(4001, "Unknown session");
	});

	it("accepts raw task IDs and project-prefixed IDs", () => {
		for (const sessionId of ["task-123", "project-456"]) {
			create(sessionId);
			const ws = socket(`ws://localhost/?session=${sessionId}`);
			serveOptions.websocket.open(ws);
			expect(ws.sessionId).toBe(sessionId);
			expect(ws.close).not.toHaveBeenCalled();
			serveOptions.websocket.close(ws);
		}
	});
});

describe("PTY frame contract", () => {
	it("writes UTF-8 input and consumes resize control frames", () => {
		create("task-input");
		const ws = socket("ws://localhost/?session=task-input");
		serveOptions.websocket.open(ws);

		serveOptions.websocket.message(ws, new TextEncoder().encode("hello\r"));
		expect(terminal.write).toHaveBeenCalledWith("hello\r");

		serveOptions.websocket.message(ws, "\x1b]resize;100;31\x07");
		expect(terminal.resize).toHaveBeenLastCalledWith(100, 31);
		expect(terminal.write).toHaveBeenCalledTimes(1);

		serveOptions.websocket.message(ws, "\x1b]resize;malformed\x07");
		expect(terminal.write).toHaveBeenCalledTimes(1);
	});

	it("uses the independent minimum rows and columns across clients", () => {
		create("task-size");
		const wideShort = socket("ws://localhost/?session=task-size");
		const narrowTall = socket("ws://localhost/?session=task-size");
		serveOptions.websocket.open(wideShort);
		serveOptions.websocket.open(narrowTall);

		serveOptions.websocket.message(wideShort, "\x1b]resize;180;28\x07");
		serveOptions.websocket.message(narrowTall, "\x1b]resize;90;52\x07");
		expect(terminal.resize).toHaveBeenLastCalledWith(90, 28);

		serveOptions.websocket.close(narrowTall);
		expect(terminal.resize).toHaveBeenLastCalledWith(180, 28);
	});

	it("removes OSC 52 from PTY output and emits decoded clipboard push data", () => {
		create("task-osc52-contract");
		const clipboard = vi.fn();
		pty.setOnOsc52Copy(clipboard);
		const text = "native clipboard ✓";
		const encoded = Buffer.from(text).toString("base64");

		outputCallback?.(null, `before\x1b]52;c;${encoded.slice(0, 5)}`);
		outputCallback?.(null, `${encoded.slice(5)}\x1b\\after`);

		expect(clipboard).toHaveBeenCalledWith({
			taskId: "task-osc52-contract",
			text,
			len: text.length,
		});
	});
});

