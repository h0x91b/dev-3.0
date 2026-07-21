import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	createRenderer: vi.fn(),
	ingest: vi.fn(),
	readResponses: vi.fn(),
	dispose: vi.fn(),
	terminalWrite: vi.fn(),
}));

vi.mock("../../../spawn", () => ({ spawn: mocks.spawn }));
vi.mock("../ghostty-renderer-probe", () => ({
	GhosttyRendererProbe: { create: mocks.createRenderer },
}));

import { capturePtyFrame } from "../capture-pty";

function emitFromMockPty(bytes: Uint8Array): void {
	mocks.spawn.mockImplementation((_command, options) => {
		let exit: (code: number) => void = () => {};
		const process = {
			exitCode: null as number | null,
			exited: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			kill: vi.fn(),
			terminal: { write: mocks.terminalWrite },
		};
		queueMicrotask(() => {
			options.terminal.data(process.terminal, bytes);
			process.exitCode = 0;
			exit(0);
		});
		return process;
	});
}

describe("PTY frame capture", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createRenderer.mockResolvedValue({
			ingest: mocks.ingest,
			readResponses: mocks.readResponses,
			dispose: mocks.dispose,
		});
		mocks.readResponses.mockReturnValue([]);
	});

	it("captures raw PTY bytes without constructing a Ghostty renderer", async () => {
		const expected = new TextEncoder().encode("PowerShell capture");
		emitFromMockPty(expected);

		const actual = await capturePtyFrame({
			command: ["powershell.exe", "-NoProfile"],
			cwd: "C:\\worktree",
			cols: 100,
			rows: 30,
			settleMs: 10,
		});

		expect(actual).toEqual(expected);
		expect(mocks.createRenderer).not.toHaveBeenCalled();
	});

	it("opts into Ghostty only when terminal query responses are required", async () => {
		const bytes = new TextEncoder().encode("\x1b[5n");
		emitFromMockPty(bytes);
		mocks.readResponses.mockReturnValue(["\x1b[0n"]);

		await capturePtyFrame({
			command: ["nvim", "--clean"],
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			settleMs: 10,
			respondToTerminalQueries: true,
		});

		expect(mocks.createRenderer).toHaveBeenCalledOnce();
		expect(mocks.ingest).toHaveBeenCalledWith(bytes);
		expect(mocks.terminalWrite).toHaveBeenCalledWith("\x1b[0n");
		expect(mocks.dispose).toHaveBeenCalledOnce();
	});
});
