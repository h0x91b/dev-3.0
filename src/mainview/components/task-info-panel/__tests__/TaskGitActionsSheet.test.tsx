import { fireEvent, render, screen } from "@testing-library/react";
import TaskGitActionsSheet from "../TaskGitActionsSheet";
import type { TaskBranchStatusController } from "../useTaskBranchStatus";
import { I18nProvider } from "../../../i18n";
import type { Project, Task } from "../../../../shared/types";

const project: Project = {
	id: "p1", name: "Test", path: "/tmp/test", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z",
};

const reviewed = { number: 2067, url: "https://github.com/h0x91b/dev-3.0/pull/2067" };

function reviewTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1", seq: 1, projectId: "p1", title: "Review", description: "Review", status: "review-by-user",
		baseBranch: "main", worktreePath: "/tmp/wt", branchName: "dev3/task-t1", groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		taskType: "pr-review", foreignCode: true, existingBranch: "mcaldas/fix/x", reviewedPr: reviewed,
		...overrides,
	};
}

const git = {
	baseBranch: "main", branchStatus: null, compareRef: "", displayRef: "", mergeRoute: null,
	handleCommit: vi.fn(), handleCreatePR: vi.fn(), handleMerge: vi.fn(), handleOpenPR: vi.fn(),
	handlePush: vi.fn(), handleRebase: vi.fn(), handleRefreshStatus: vi.fn(),
	refreshingStatus: false, statusError: null, statusLoading: false,
} as unknown as TaskBranchStatusController;

function renderSheet(task: Task, onAction = vi.fn(), sheetProject: Project = project, onOpenInlineDiff?: () => void) {
	render(
		<I18nProvider>
			<TaskGitActionsSheet task={task} project={sheetProject} isTaskActive git={git} rowClassName="row" onAction={onAction} onOpenInlineDiff={onOpenInlineDiff} />
		</I18nProvider>,
	);
	return onAction;
}

describe("TaskGitActionsSheet reviewed PR row", () => {
	it("opens the reviewed PR and dismisses the sheet", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const onAction = renderSheet(reviewTask());

		fireEvent.click(screen.getByRole("button", { name: /Open reviewed PR #2067/ }));

		expect(open).toHaveBeenCalledWith(reviewed.url, "_blank");
		expect(onAction).toHaveBeenCalledTimes(1);
		open.mockRestore();
	});

	it("yields to the task's own PR row when both name the same PR", () => {
		renderSheet(reviewTask({ prNumber: 2067, prUrl: reviewed.url }));

		expect(screen.getByRole("button", { name: /Open PR #2067/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Open reviewed PR/ })).not.toBeInTheDocument();
	});

	it("adds no row without a known reviewed PR", () => {
		renderSheet(reviewTask({ reviewedPr: null }));

		expect(screen.queryByRole("button", { name: /Open reviewed PR/ })).not.toBeInTheDocument();
	});
});

describe("TaskGitActionsSheet on an Operations task", () => {
	const ops: Project = { ...project, kind: "virtual" };

	it("renders nothing without an attached repo", () => {
		renderSheet(reviewTask(), vi.fn(), ops, vi.fn());

		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("with an attached repo offers Show diff and no write action", () => {
		renderSheet(reviewTask({ attachedRepo: "/Users/me/repo", reviewedPr: null }), vi.fn(), ops, vi.fn());

		expect(screen.getByRole("button", { name: /Show Diff/ })).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
