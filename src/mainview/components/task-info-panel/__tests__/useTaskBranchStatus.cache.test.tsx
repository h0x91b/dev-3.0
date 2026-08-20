import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BranchStatus, Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { clearBranchStatusCache } from "../branchStatusCache";
import { useTaskBranchStatus } from "../useTaskBranchStatus";

const getBranchStatus = vi.fn();

vi.mock("../../../rpc", () => ({
	api: { request: { getBranchStatus: (...args: unknown[]) => getBranchStatus(...args) } },
}));

vi.mock("../../../toast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

vi.mock("../../../utils/offerMergeCompletion", () => ({ offerMergeCompletion: vi.fn() }));

const project = { id: "project-1", defaultBaseBranch: "main" } as Project;

function taskWithId(id: string): Task {
	return { id, status: "in-progress", worktreePath: `/wt/${id}`, baseBranch: "main" } as Task;
}

function statusFor(ahead: number): BranchStatus {
	return { ahead, behind: 0, insertions: 0, deletions: 0, diffFiles: 0, diffInsertions: 0, diffDeletions: 0 } as BranchStatus;
}

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

const dispatch = vi.fn();
const navigate = vi.fn();

function renderForTask(task: Task) {
	return renderHook(
		({ task: t }: { task: Task }) =>
			useTaskBranchStatus({ task: t, project, dispatch, navigate, isTaskActive: true }),
		{ wrapper, initialProps: { task } },
	);
}

describe("useTaskBranchStatus — stale-while-refreshing status", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearBranchStatusCache();
	});

	it("shows the task's last known status immediately when switching back to it", async () => {
		getBranchStatus.mockImplementation(({ taskId }: { taskId: string }) =>
			Promise.resolve(statusFor(taskId === "task-a" ? 3 : 7)),
		);

		const { result, rerender } = renderForTask(taskWithId("task-a"));
		await waitFor(() => expect(result.current.branchStatus?.ahead).toBe(3));

		await act(async () => rerender({ task: taskWithId("task-b") }));
		await waitFor(() => expect(result.current.branchStatus?.ahead).toBe(7));

		// Back to A: the cached numbers paint on the first render, no spinner.
		let pending: (status: BranchStatus) => void = () => {};
		getBranchStatus.mockImplementation(() => new Promise<BranchStatus>((resolve) => { pending = resolve; }));
		rerender({ task: taskWithId("task-a") });
		expect(result.current.branchStatus?.ahead).toBe(3);
		expect(result.current.statusLoading).toBe(false);

		// The refetch replaces them in place once it lands.
		await act(async () => { pending(statusFor(5)); });
		await waitFor(() => expect(result.current.branchStatus?.ahead).toBe(5));
	});

	// The poll used to hold the merge-completion callback as an effect dep. That
	// callback's identity follows the `task`/`project` objects, which a task-list
	// push replaces — so every render restarted the poll and refetched, spinning
	// into thousands of git calls a second.
	it("polls once regardless of unstable props and callbacks", async () => {
		getBranchStatus.mockResolvedValue(statusFor(3));

		const { result, rerender } = renderHook(
			() =>
				useTaskBranchStatus({
					// Fresh objects and callbacks on every render, as the real app does.
					task: taskWithId("task-a"),
					project: { ...project },
					dispatch: vi.fn(),
					navigate: vi.fn(),
					isTaskActive: true,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.branchStatus?.ahead).toBe(3));

		for (let i = 0; i < 5; i++) {
			rerender();
		}
		await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

		expect(getBranchStatus).toHaveBeenCalledTimes(1);
	});

	it("loads without stale numbers for a task never seen before", async () => {
		getBranchStatus.mockImplementation(({ taskId }: { taskId: string }) =>
			Promise.resolve(statusFor(taskId === "task-a" ? 3 : 7)),
		);

		const { result, rerender } = renderForTask(taskWithId("task-a"));
		await waitFor(() => expect(result.current.branchStatus?.ahead).toBe(3));

		getBranchStatus.mockImplementation(() => new Promise<BranchStatus>(() => {}));
		rerender({ task: taskWithId("task-c") });
		expect(result.current.branchStatus).toBeNull();
		expect(result.current.statusLoading).toBe(true);
	});
});
