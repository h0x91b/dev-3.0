import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { useTaskBranchStatus } from "../useTaskBranchStatus";

vi.mock("../../../rpc", () => ({ api: { request: {} } }));

const task = { id: "task-1", status: "in-progress", worktreePath: "/wt", ownWorktree: true } as Task;

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

function render(project: Project) {
	// `enabled: false` keeps the poll inert: no branch status, so no live PR either.
	return renderHook(
		() => useTaskBranchStatus({ task, project, dispatch: vi.fn(), navigate: vi.fn(), isTaskActive: true, enabled: false }),
		{ wrapper },
	).result.current;
}

describe("useTaskBranchStatus - local merge in a shared folder", () => {
	it("blocks the local squash when the project's git workflow is off", () => {
		const status = render({ id: "p1", defaultBaseBranch: "main", gitWorkflow: false } as Project);
		expect(status.mergeRoute).toBe("local-squash");
		expect(status.localMergeBlocked).toBe(true);
	});

	it("leaves it alone in a project with the git workflow", () => {
		expect(render({ id: "p1", defaultBaseBranch: "main" } as Project).localMergeBlocked).toBe(false);
	});
});
