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
	it("reports an unmarked task as effective tmux without claiming it is explicit", async () => {
		expect(await readTaskTerminalBackendState(makeTask())).toEqual({
			backend: "tmux",
			explicit: false,
			liveBackend: null,
		});
	});

	it("reports an explicit identity together with the live owner", async () => {
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
	it.each(["tmux", "native"] as const)("persists %s for a stopped task", async (target) => {
		const { state } = await switchTaskTerminalBackend(project, makeTask(), target);
		expect(setTaskTerminalBackend).toHaveBeenCalledWith(project, expect.any(String), target);
		expect(state).toMatchObject({ backend: target, explicit: true });
	});

	it("rejects an identity this build cannot decode, writing nothing", async () => {
		await expect(switchTaskTerminalBackend(project, makeTask(), "screen")).rejects.toThrow(
			/Invalid terminal backend/,
		);
		expect(setTaskTerminalBackend).not.toHaveBeenCalled();
	});

	// Backend-neutral: the refusal must look identical whichever side is alive,
	// and in both directions.
	it.each([
		{ live: "native" as const, from: "native" as const, to: "tmux" as const },
		{ live: "tmux" as const, from: "tmux" as const, to: "native" as const },
	])("refuses to switch away from a live $live session and mutates nothing", async ({ live, from, to }) => {
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
	});

	it("refuses a live unmarked (legacy tmux) task the same way", async () => {
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
	it("reports a resolvable host with its provenance", () => {
		resolveNativeHostRuntime.mockReturnValue({ origin: "staged packaged host image abc" });
		expect(nativeTerminalAvailability("darwin")).toEqual({
			available: true,
			tmuxSupported: true,
			origin: "staged packaged host image abc",
			diagnostics: [],
		});
	});

	it("surfaces the install diagnostics instead of throwing or falling back to tmux", () => {
		resolveNativeHostRuntime.mockImplementation(() => {
			throw new NativeHostRuntimeError("no host", ["Reinstall dev3 from a package that ships native-host-image/."]);
		});
		expect(nativeTerminalAvailability("linux")).toEqual({
			available: false,
			tmuxSupported: true,
			diagnostics: ["Reinstall dev3 from a package that ships native-host-image/."],
		});
	});

	it("marks tmux unsupported on Windows", () => {
		resolveNativeHostRuntime.mockReturnValue({ origin: "packaged" });
		expect(nativeTerminalAvailability("win32")).toMatchObject({ available: true, tmuxSupported: false });
	});

	it("still answers for a non-NativeHostRuntimeError failure", () => {
		resolveNativeHostRuntime.mockImplementation(() => {
			throw new Error("disk on fire");
		});
		expect(nativeTerminalAvailability("darwin")).toMatchObject({
			available: false,
			diagnostics: ["Error: disk on fire"],
		});
	});
});
