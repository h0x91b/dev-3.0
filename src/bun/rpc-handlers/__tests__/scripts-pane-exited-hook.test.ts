import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	runScript: vi.fn(),
	installPaneExitedHook: vi.fn(async () => {}),
}));

vi.mock("../../data", () => ({
	getProject: vi.fn(async () => ({ id: "p1" })),
	getTask: vi.fn(async () => ({ id: "abcdef12-0000", worktreePath: "/wt", tmuxSocket: "sock" })),
	updateTaskWith: vi.fn(async () => ({ task: { id: "abcdef12-0000" } })),
}));
vi.mock("../../task-workspace-guard", () => ({ assertTaskWorkspacePresent: vi.fn() }));
vi.mock("../../package-scripts", () => ({ parsePackageScripts: () => ({ runner: "npm", scripts: [{ name: "build" }] }) }));
vi.mock("../../makefile", () => ({ parseMakefile: () => ({ targets: [] }) }));
vi.mock("../../script-runner", () => ({ runScript: mocks.runScript }));
vi.mock("../../pty-server", () => ({ installPaneExitedHook: mocks.installPaneExitedHook }));
vi.mock("../shared-pure", () => ({ getPushMessage: () => null, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { scriptsHandlers } from "../scripts";

const params = { taskId: "abcdef12-0000", projectId: "p1", scriptName: "build", source: "package" as const, placement: "window" as const };

beforeEach(() => vi.clearAllMocks());

describe("runScript pane-exited hook", () => {
	it("gives the window the script opened the task session's pane-exited hook", async () => {
		mocks.runScript.mockResolvedValue("%14");
		await scriptsHandlers.runScript(params);
		expect(mocks.installPaneExitedHook).toHaveBeenCalledWith("dev3-abcdef12", "%14", "sock");
	});

	it("installs nothing when no pane id came back", async () => {
		mocks.runScript.mockResolvedValue(null);
		await scriptsHandlers.runScript(params);
		expect(mocks.installPaneExitedHook).not.toHaveBeenCalled();
	});
});
