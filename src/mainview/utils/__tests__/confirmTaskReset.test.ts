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
		expect(await confirmTaskReset(task, project, t)).toEqual({ worktreePath: "/wt", lifecycleStartedAt: "S" });
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

	it("an Operations task says its folder is kept and runs no git check", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		await confirmTaskReset(task, { ...project, kind: "virtual" } as Project, t);
		expect(vi.mocked(confirm).mock.calls[0]![0].message).toBe("task.confirmResetMessageVirtual");
		expect(api.request.getUnsavedWork).not.toHaveBeenCalled();
	});
});
