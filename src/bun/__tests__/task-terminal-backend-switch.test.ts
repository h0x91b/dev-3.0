import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

const codec = await vi.hoisted(async () => await import("../../shared/terminal-backend-identity"));

const setTaskTerminalBackend = vi.hoisted(() => vi.fn());
const nativeTaskPanesAlive = vi.hoisted(() => vi.fn());
const tmuxSessionExists = vi.hoisted(() => vi.fn());
const resolveNativeHostRuntime = vi.hoisted(() => vi.fn());

vi.mock("../data", () => ({
	readTaskTerminalBackend: (task: unknown) => codec.decodeTerminalBackend(task),
	setTaskTerminalBackend,
}));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesAlive }));
vi.mock("../pty-server", () => ({ tmuxSessionExists }));
vi.mock("../native-host-runtime", async () => {
	const actual = await vi.importActual<typeof import("../native-host-runtime")>("../native-host-runtime");
	return { NativeHostRuntimeError: actual.NativeHostRuntimeError, resolveNativeHostRuntime };
});

import { NativeHostRuntimeError } from "../native-host-runtime";
import {
	liveTaskTerminalBackend,
	nativeTerminalAvailability,
	readTaskTerminalBackendState,
	switchTaskTerminalBackend,
	TerminalBackendSwitchError,
} from "../task-terminal-backend-switch";

const project = { id: "proj-1" } as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
	return { id: "11111111-2222-3333-4444-555555555555", tmuxSocket: "dev3", ...overrides } as Task;
}

/** No session anywhere — the "stopped task" baseline. */
function noLiveSession(): void {
	nativeTaskPanesAlive.mockResolvedValue(false);
	tmuxSessionExists.mockResolvedValue(false);
}

beforeEach(() => {
	vi.clearAllMocks();
	setTaskTerminalBackend.mockImplementation(async (_project: Project, _taskId: string, backend: string) =>
		makeTask({ terminalBackend: backend as Task["terminalBackend"] }),
	);
	noLiveSession();
});

describe("liveTaskTerminalBackend", () => {
	it("reports whichever backend owns a session, and null when both are stopped", async () => {
		expect(await liveTaskTerminalBackend(makeTask())).toBeNull();

		nativeTaskPanesAlive.mockResolvedValue(true);
		expect(await liveTaskTerminalBackend(makeTask())).toBe("native");

		nativeTaskPanesAlive.mockResolvedValue(false);
		tmuxSessionExists.mockResolvedValue(true);
		expect(await liveTaskTerminalBackend(makeTask())).toBe("tmux");
	});
});

describe("readTaskTerminalBackendState", () => {
	it("reports an unmarked task as effective tmux without claiming it is explicit, and an explicit identity with its live owner", async () => {
		expect(await readTaskTerminalBackendState(makeTask())).toEqual({
			backend: "tmux",
			explicit: false,
			liveBackend: null,
		});

		nativeTaskPanesAlive.mockResolvedValue(true);
		expect(await readTaskTerminalBackendState(makeTask({ terminalBackend: "native" }))).toEqual({
			backend: "native",
			explicit: true,
			liveBackend: "native",
		});
	});

	it("refuses to guess for an unreadable stored value", async () => {
		const task = makeTask({ terminalBackend: "screen" as Task["terminalBackend"] });
		await expect(readTaskTerminalBackendState(task)).rejects.toThrow(TerminalBackendSwitchError);
	});
});

describe("switchTaskTerminalBackend", () => {
	it("persists either backend for a stopped task", async () => {
		for (const target of ["tmux", "native"] as const) {
			const { state } = await switchTaskTerminalBackend(project, makeTask(), target);
			expect(setTaskTerminalBackend).toHaveBeenCalledWith(project, expect.any(String), target);
			expect(state).toMatchObject({ backend: target, explicit: true });
		}
	});

	it("rejects an identity this build cannot decode, writing nothing", async () => {
		await expect(switchTaskTerminalBackend(project, makeTask(), "screen")).rejects.toThrow(
			/Invalid terminal backend/,
		);
		expect(setTaskTerminalBackend).not.toHaveBeenCalled();
	});

	// Backend-neutral: the refusal must look identical whichever side is alive,
	// and in both directions.
	it("refuses to switch away from a live session in either direction (legacy unmarked tmux too) and mutates nothing", async () => {
		const cases = [
			{ live: "native" as const, from: "native" as const, to: "tmux" as const },
			{ live: "tmux" as const, from: "tmux" as const, to: "native" as const },
		];
		for (const { live, from, to } of cases) {
			nativeTaskPanesAlive.mockResolvedValue(live === "native");
			tmuxSessionExists.mockResolvedValue(live === "tmux");
			const task = makeTask({ terminalBackend: from });

			await expect(switchTaskTerminalBackend(project, task, to)).rejects.toThrow(
				new RegExp(`still has a live ${live} terminal`),
			);
			// `setTaskTerminalBackend` is the ONLY writer of the field, and the module
			// touches no session API beyond the two read-only probes.
			expect(setTaskTerminalBackend).not.toHaveBeenCalled();
			expect(task.terminalBackend).toBe(from);
		}

		nativeTaskPanesAlive.mockResolvedValue(false);
		tmuxSessionExists.mockResolvedValue(true);
		await expect(switchTaskTerminalBackend(project, makeTask(), "native")).rejects.toThrow(
			/still has a live tmux terminal/,
		);
		expect(setTaskTerminalBackend).not.toHaveBeenCalled();
	});

	it("allows re-selecting the backend a live session already runs on — it changes nothing", async () => {
		nativeTaskPanesAlive.mockResolvedValue(true);
		await switchTaskTerminalBackend(project, makeTask({ terminalBackend: "native" }), "native");
		expect(setTaskTerminalBackend).toHaveBeenCalledWith(project, expect.any(String), "native");
	});
});

describe("nativeTerminalAvailability", () => {
	it("reports a resolvable host with its provenance, marking tmux unsupported on Windows", () => {
		resolveNativeHostRuntime.mockReturnValue({ origin: "staged packaged host image abc" });
		expect(nativeTerminalAvailability("darwin")).toEqual({
			available: true,
			tmuxSupported: true,
			origin: "staged packaged host image abc",
			diagnostics: [],
		});
		resolveNativeHostRuntime.mockReturnValue({ origin: "packaged" });
		expect(nativeTerminalAvailability("win32")).toMatchObject({ available: true, tmuxSupported: false });
	});

	it("surfaces the install diagnostics instead of throwing or falling back to tmux, for any failure", () => {
		resolveNativeHostRuntime.mockImplementation(() => {
			throw new NativeHostRuntimeError("no host", ["Reinstall dev3 from a package that ships native-host-image/."]);
		});
		expect(nativeTerminalAvailability("linux")).toEqual({
			available: false,
			tmuxSupported: true,
			diagnostics: ["Reinstall dev3 from a package that ships native-host-image/."],
		});

		resolveNativeHostRuntime.mockImplementation(() => {
			throw new Error("disk on fire");
		});
		expect(nativeTerminalAvailability("darwin")).toMatchObject({
			available: false,
			diagnostics: ["Error: disk on fire"],
		});
	});
});
