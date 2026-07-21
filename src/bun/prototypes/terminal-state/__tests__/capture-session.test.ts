import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureSessionSpec } from "../capture-session";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../../spawn", () => ({ spawn: mocks.spawn }));

import { captureSession } from "../capture-session";

function installMockChild(emit: Uint8Array): {
	terminal: { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
} {
	const terminal = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
	let resolveExited: (code: number) => void = () => {};
	const proc = {
		exitCode: null as number | null,
		exited: new Promise<number>((resolve) => {
			resolveExited = resolve;
		}),
		kill: vi.fn(() => {
			proc.exitCode = 0;
			resolveExited(0);
		}),
		terminal,
	};
	mocks.spawn.mockImplementation((_command, options) => {
		queueMicrotask(() => options.terminal.data(terminal, emit));
		return proc;
	});
	return { terminal };
}

function baseSpec(overrides: Partial<CaptureSessionSpec>): CaptureSessionSpec {
	return {
		target: "claude",
		kind: "agent",
		command: ["claude"],
		cwd: "C:\\worktree",
		cols: 80,
		rows: 24,
		respondToQueries: true,
		exitGraceMs: 5,
		platform: "Windows 10.0.19045 x86_64; Bun 1.3.14",
		capturedAt: "2026-07-22",
		script: [
			{ type: "wait", ms: 5 },
			{ type: "input", data: "q" },
			{ type: "resize", cols: 100, rows: 30 },
			{ type: "detach" },
			{ type: "wait", ms: 5 },
		],
		...overrides,
	};
}

describe("captureSession", () => {
	beforeEach(() => vi.clearAllMocks());

	it("records output, resize, and detach while answering terminal queries", async () => {
		const { terminal } = installMockChild(new TextEncoder().encode("\x1b[6n"));

		const journal = await captureSession(baseSpec({}));

		expect(journal.events[0]).toMatchObject({ type: "output", encoding: "base64" });
		expect(journal.events).toContainEqual({ type: "resize", cols: 100, rows: 30 });
		expect(journal.detachIndex).toBe(2);
		expect(journal.finalDimensions).toEqual({ cols: 100, rows: 30 });
		expect(journal.responderReplies).toBe(1);
		expect(journal.queryCounts["DSR-cursor"]).toBe(1);
		expect(journal.provenance.exitCode).toBe(0);

		expect(terminal.write.mock.calls.map((call) => call[0])).toEqual(
			expect.arrayContaining(["\x1b[1;1R", "q"]),
		);
		expect(terminal.resize).toHaveBeenCalledWith(100, 30);
	});

	it("does not answer queries when responding is disabled", async () => {
		installMockChild(new TextEncoder().encode("\x1b[6n"));

		const journal = await captureSession(
			baseSpec({ respondToQueries: false, kind: "shell", target: "cmd" }),
		);

		expect(journal.responderReplies).toBe(0);
		expect(journal.queryCounts).toEqual({});
	});
});
