import { act, renderHook } from "@testing-library/react";
import { I18nProvider } from "../../../i18n";
import type { Project, Task } from "../../../../shared/types";

const order: string[] = [];
const openFileBrowser = vi.fn();
const requestTaskTerminalFocus = vi.fn((_taskId: string) => { order.push("focus"); });

vi.mock("../../../rpc", () => ({
	api: { request: { openFileBrowser: (...args: unknown[]) => openFileBrowser(...args) } },
}));
vi.mock("../../../toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../../terminal-focus-request", () => ({
	requestTaskTerminalFocus: (taskId: string) => requestTaskTerminalFocus(taskId),
}));

import { useYaziLauncher } from "../useYaziLauncher";

const task = { id: "task-1" } as Task;
const project = { id: "project-1" } as Project;

beforeEach(() => {
	order.length = 0;
	vi.clearAllMocks();
	openFileBrowser.mockImplementation(async () => { order.push("rpc"); });
});

describe("useYaziLauncher", () => {
	// The terminal waits for a pane it has not seen yet; polling can report the new
	// pane before the RPC replies, so the wish has to be on record first.
	it("asks for terminal focus before the open RPC is sent", async () => {
		const { result } = renderHook(() => useYaziLauncher(task, project), { wrapper: I18nProvider });

		await act(async () => { await result.current.launch(); });

		expect(requestTaskTerminalFocus).toHaveBeenCalledWith("task-1");
		expect(order).toEqual(["focus", "rpc"]);
	});

	it("does nothing without a task", async () => {
		const { result } = renderHook(() => useYaziLauncher(undefined, project), { wrapper: I18nProvider });

		await act(async () => { await result.current.launch(); });

		expect(requestTaskTerminalFocus).not.toHaveBeenCalled();
		expect(openFileBrowser).not.toHaveBeenCalled();
	});
});
