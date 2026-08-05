import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentPromptDeliveryStatus } from "../../../../shared/agent-prompt-delivery";
import type { Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { useTaskBranchStatus } from "../useTaskBranchStatus";

const createPullRequest = vi.fn();

vi.mock("../../../rpc", () => ({
	api: { request: { createPullRequest: (...args: unknown[]) => createPullRequest(...args) } },
}));

const toastCalls: Array<{ level: string; message: string }> = [];

vi.mock("../../../toast", () => ({
	toast: {
		info: (message: string) => void toastCalls.push({ level: "info", message }),
		error: (message: string) => void toastCalls.push({ level: "error", message }),
	},
}));

const task = { id: "task-1", status: "in-progress", worktreePath: "/wt" } as Task;
const project = { id: "project-1", defaultBaseBranch: "main" } as Project;

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

async function createPRWithVerdict(status: AgentPromptDeliveryStatus) {
	toastCalls.length = 0;
	createPullRequest.mockResolvedValue({ delivery: { status } });
	// `enabled: false` keeps the branch-status poll inert — this suite is only
	// about what the user is told after the handoff.
	const { result } = renderHook(
		() => useTaskBranchStatus({ task, project, dispatch: vi.fn(), navigate: vi.fn(), isTaskActive: true, enabled: false }),
		{ wrapper },
	);
	await act(() => result.current.handleCreatePR(false));
	return toastCalls;
}

describe("useTaskBranchStatus — Create PR feedback", () => {
	beforeEach(() => vi.clearAllMocks());

	it("confirms the handoff without claiming a PR exists", async () => {
		const calls = await createPRWithVerdict("delivered");
		expect(calls).toEqual([{ level: "info", message: "Handed PR creation to the agent — watch the terminal" }]);
	});

	it("says so when delivery could not be confirmed, and does not call it a failure", async () => {
		const calls = await createPRWithVerdict("unconfirmed");
		expect(calls[0].level).toBe("info");
		expect(calls[0].message).toContain("could not be confirmed");
	});

	it("reports a proven no-pane as an error", async () => {
		const calls = await createPRWithVerdict("not-delivered");
		expect(calls).toEqual([{ level: "error", message: "No agent terminal found to hand PR creation to" }]);
	});

	it("passes autoMerge through and still reports the verdict", async () => {
		toastCalls.length = 0;
		createPullRequest.mockResolvedValue({ delivery: { status: "delivered" } });
		const { result } = renderHook(
			() => useTaskBranchStatus({ task, project, dispatch: vi.fn(), navigate: vi.fn(), isTaskActive: true, enabled: false }),
			{ wrapper },
		);
		await act(() => result.current.handleCreatePR(true));
		expect(createPullRequest).toHaveBeenCalledWith({ taskId: "task-1", projectId: "project-1", autoMerge: true });
		expect(toastCalls).toHaveLength(1);
	});
});
