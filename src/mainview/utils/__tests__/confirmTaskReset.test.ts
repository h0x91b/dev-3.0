import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn(() => new Promise(() => {})) } } }));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
vi.mock("../taskDialogInfo", () => ({ taskDialogInfo: vi.fn(() => ({ title: "T" })) }));

import { confirm } from "../../confirm";
import { api } from "../../rpc";
import { confirmTaskReset } from "../confirmTaskReset";

const t = ((key: string, vars?: Record<string, string>) => (vars ? `${key}:${JSON.stringify(vars)}` : key)) as never;
const task = { id: "t1", status: "in-progress", worktreePath: "/wt", branchName: "feat/dev3-x", lifecycleStartedAt: "S" } as Task;
const project = { id: "p1", name: "P", path: "/p" } as Project;

afterEach(() => vi.clearAllMocks());

describe("confirmTaskReset", () => {
	it("always asks (even a clean branch), names the branch, gates on the unsaved-work check, returns the consent it showed", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		expect(await confirmTaskReset(task, project, t)).toEqual({ worktreePath: "/wt", lifecycleStartedAt: "S", attachedRepo: null });
		const options = vi.mocked(confirm).mock.calls[0]![0];
		expect(options).toMatchObject({ danger: true, tone: "danger", confirmLabel: "task.confirmResetLabel" });
		expect(options.message).toContain("feat/dev3-x");
		expect(options.deferred?.gateConfirm).toBe(true);
		expect(api.request.getUnsavedWork).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
	});

	it("declined → null", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		expect(await confirmTaskReset(task, project, t)).toBeNull();
	});

	it("an Operations worktree task gets the git-style warning and the unsaved-work check, and says its branch is kept", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		const wt = { ...task, attachedRepo: "/repo", opsWorktree: true } as Task;
		await confirmTaskReset(wt, { ...project, kind: "virtual" } as Project, t);
		const options = vi.mocked(confirm).mock.calls[0]![0];
		expect(options.message).toContain("task.confirmResetMessageOpsWorktree");
		expect(options.message).toContain("feat/dev3-x");
		expect(options.deferred?.gateConfirm).toBe(true);
		expect(api.request.getUnsavedWork).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
	});

	it("an Operations task says its folder is kept and runs no git check", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		await confirmTaskReset(task, { ...project, kind: "virtual" } as Project, t);
		expect(vi.mocked(confirm).mock.calls[0]![0].message).toBe("task.confirmResetMessageVirtual");
		expect(api.request.getUnsavedWork).not.toHaveBeenCalled();
	});

	it("an Operations task with a repo in its own folder runs the unsaved-work check and says the worktree goes, the branch stays", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		const inFolder = { ...task, attachedRepo: "/wt/wt2" } as Task;
		// The consent names the repo the dialog checked, so a reset after a swap is refused by the server.
		expect(await confirmTaskReset(inFolder, { ...project, kind: "virtual" } as Project, t)).toMatchObject({ attachedRepo: "/wt/wt2" });
		const options = vi.mocked(confirm).mock.calls[0]![0];
		expect(options.message).toContain("task.confirmResetMessageVirtual");
		expect(options.message).toContain("task.attachedWorktreeNote");
		expect(options.deferred?.gateConfirm).toBe(true);
		expect(api.request.getUnsavedWork).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
	});

	it("a repo attached outside the task folder changes nothing for an Operations reset", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		await confirmTaskReset({ ...task, attachedRepo: "/repo" } as Task, { ...project, kind: "virtual" } as Project, t);
		expect(vi.mocked(confirm).mock.calls[0]![0].message).toBe("task.confirmResetMessageVirtual");
		expect(api.request.getUnsavedWork).not.toHaveBeenCalled();
	});
});
