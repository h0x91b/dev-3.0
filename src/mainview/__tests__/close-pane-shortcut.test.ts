import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc", () => ({
	api: { request: { taskPaneState: vi.fn(), taskPaneAction: vi.fn() } },
}));
vi.mock("../confirm", () => ({ confirm: vi.fn() }));

import { api } from "../rpc";
import { confirm } from "../confirm";
import { closeFocusedPane } from "../close-pane-shortcut";
import { syncGlobalSettingsCache } from "../global-settings-cache";
import { _resetNativePaneFocus, publishNativePaneFocus } from "../native-pane-focus";
import type { GlobalSettings } from "../../shared/types";
import type { TaskPaneState } from "../../shared/task-panes";

const mockedState = vi.mocked(api.request.taskPaneState);
const mockedAction = vi.mocked(api.request.taskPaneAction);
const mockedConfirm = vi.mocked(confirm);

function paneState(backend: "tmux" | "native", ids: string[], active: string): TaskPaneState {
	return {
		backend,
		activePaneId: active,
		panes: ids.map((paneId, index) => ({ paneId, index, label: paneId, active: paneId === active, zoomed: false, rect: { x: 0, y: 0, width: 1, height: 1 } })),
	} as unknown as TaskPaneState;
}

function settings(confirmClosePane: boolean) {
	syncGlobalSettingsCache({ confirmClosePane } as GlobalSettings);
}

describe("closeFocusedPane", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetNativePaneFocus();
		mockedAction.mockResolvedValue(paneState("tmux", ["%1"], "%1"));
	});

	it("closes straight away while the setting is off", async () => {
		settings(false);
		mockedState.mockResolvedValue(paneState("tmux", ["%1", "%2"], "%2"));
		await closeFocusedPane("t1");
		expect(mockedConfirm).not.toHaveBeenCalled();
		expect(mockedAction).toHaveBeenCalledWith({ taskId: "t1", action: { kind: "close", paneId: undefined } });
	});

	it("asks which pane by its number, and closes on yes", async () => {
		settings(true);
		mockedState.mockResolvedValue(paneState("tmux", ["%1", "%2"], "%2"));
		mockedConfirm.mockResolvedValue(true);
		await closeFocusedPane("t1");
		expect(mockedConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Close pane 2?", danger: true, keyboardChoice: true }));
		expect(mockedAction).toHaveBeenCalled();
	});

	it("keeps the pane on no", async () => {
		settings(true);
		mockedState.mockResolvedValue(paneState("tmux", ["%1", "%2"], "%1"));
		mockedConfirm.mockResolvedValue(false);
		await closeFocusedPane("t1");
		expect(mockedAction).not.toHaveBeenCalled();
	});

	it("does not ask about a lone pane the server will refuse anyway", async () => {
		settings(true);
		mockedState.mockResolvedValue(paneState("tmux", ["%1"], "%1"));
		await closeFocusedPane("t1");
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("names and closes this viewer's focused pane on native, not the server's active one", async () => {
		settings(true);
		mockedState.mockResolvedValue(paneState("native", ["pane-1", "pane-2", "pane-3"], "pane-1"));
		publishNativePaneFocus("t1", "pane-3");
		mockedConfirm.mockResolvedValue(true);
		await closeFocusedPane("t1");
		expect(mockedConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Close pane 3?" }));
		expect(mockedAction).toHaveBeenCalledWith({ taskId: "t1", action: { kind: "close", paneId: "pane-3" } });
	});
});
