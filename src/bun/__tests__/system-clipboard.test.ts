import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("../which", () => ({
	whichSync: vi.fn(),
}));

import { spawn } from "../spawn";
import { whichSync } from "../which";
import { writeSystemClipboard, _resetClipboardToolForTests } from "../system-clipboard";

const mockSpawn = vi.mocked(spawn);
const mockWhichSync = vi.mocked(whichSync);

const originalPlatform = process.platform;
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;

function setPlatform(p: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeProc() {
	const sink = { write: vi.fn(), end: vi.fn() };
	return {
		pid: 1,
		stdin: sink,
		stdout: null,
		exited: Promise.resolve(0),
	} as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetClipboardToolForTests();
	mockSpawn.mockReturnValue(makeProc());
	delete process.env.WAYLAND_DISPLAY;
});

afterEach(() => {
	setPlatform(originalPlatform);
	if (originalWaylandDisplay !== undefined) {
		process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
	} else {
		delete process.env.WAYLAND_DISPLAY;
	}
});

describe("writeSystemClipboard", () => {
	it("uses pbcopy on macOS", () => {
		setPlatform("darwin");
		mockWhichSync.mockReturnValue("/usr/bin/pbcopy");

		const tool = writeSystemClipboard("hello");

		expect(tool).toBe("pbcopy");
		expect(mockSpawn).toHaveBeenCalledWith(
			["/usr/bin/pbcopy"],
			expect.objectContaining({ stdin: "pipe" }),
		);
		const proc = mockSpawn.mock.results[0]!.value;
		expect(proc.stdin.write).toHaveBeenCalledWith("hello");
		expect(proc.stdin.end).toHaveBeenCalled();
	});

	it("falls back to bare 'pbcopy' when which fails on macOS", () => {
		setPlatform("darwin");
		mockWhichSync.mockReturnValue(null);

		const tool = writeSystemClipboard("x");

		expect(tool).toBe("pbcopy");
		expect(mockSpawn).toHaveBeenCalledWith(["pbcopy"], expect.any(Object));
	});

	it("uses wl-copy on Linux Wayland when available", () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		mockWhichSync.mockImplementation((c: string) => (c === "wl-copy" ? "/usr/bin/wl-copy" : null));

		const tool = writeSystemClipboard("hi");

		expect(tool).toBe("wl-copy");
		expect(mockSpawn).toHaveBeenCalledWith(["/usr/bin/wl-copy"], expect.any(Object));
	});

	it("uses xclip on Linux X11 when wl-copy unavailable", () => {
		setPlatform("linux");
		mockWhichSync.mockImplementation((c: string) => (c === "xclip" ? "/usr/bin/xclip" : null));

		const tool = writeSystemClipboard("hi");

		expect(tool).toBe("xclip");
		expect(mockSpawn).toHaveBeenCalledWith(
			["/usr/bin/xclip", "-selection", "clipboard"],
			expect.any(Object),
		);
	});

	it("returns null on Linux when no clipboard tool exists", () => {
		setPlatform("linux");
		mockWhichSync.mockReturnValue(null);

		const tool = writeSystemClipboard("hi");

		expect(tool).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("returns null on win32 (unsupported)", () => {
		setPlatform("win32");
		mockWhichSync.mockReturnValue(null);

		const tool = writeSystemClipboard("hi");

		expect(tool).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("caches the resolved tool — only resolves once across calls", () => {
		setPlatform("darwin");
		mockWhichSync.mockReturnValue("/usr/bin/pbcopy");

		writeSystemClipboard("a");
		writeSystemClipboard("b");
		writeSystemClipboard("c");

		expect(mockWhichSync).toHaveBeenCalledTimes(1);
		expect(mockSpawn).toHaveBeenCalledTimes(3);
	});

	it("returns null and does not throw if spawn fails", () => {
		setPlatform("darwin");
		mockWhichSync.mockReturnValue("/usr/bin/pbcopy");
		mockSpawn.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(() => writeSystemClipboard("x")).not.toThrow();
		expect(writeSystemClipboard("x")).toBeNull();
	});
});
