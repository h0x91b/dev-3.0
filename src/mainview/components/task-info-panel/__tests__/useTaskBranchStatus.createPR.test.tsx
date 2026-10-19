import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentPromptDeliveryStatus } from "../../../../shared/agent-prompt-delivery";
import type { Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { useTaskBranchStatus } from "../useTaskBranchStatus";

const createPullRequest = vi.fn();
const commitTaskViaAgent = vi.fn();

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			createPullRequest: (...args: unknown[]) => createPullRequest(...args),
			commitTaskViaAgent: (...args: unknown[]) => commitTaskViaAgent(...args),
		},
	},
}));

const toastCalls: Array<{ level: string; message: string }> = [];
const toastOpts: Array<Record<string, unknown> | undefined> = [];

vi.mock("../../../toast", () => ({
	toast: {
		info: (message: string, opts?: Record<string, unknown>) => {
			toastCalls.push({ level: "info", message });
			toastOpts.push(opts);
		},
		error: (message: string, opts?: Record<string, unknown>) => {
			toastCalls.push({ level: "error", message });
			toastOpts.push(opts);
		},
	},
}));

const task = { id: "task-1", status: "in-progress", worktreePath: "/wt" } as Task;
const project = { id: "project-1", defaultBaseBranch: "main" } as Project;

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

async function createPRWithVerdict(status: AgentPromptDeliveryStatus, reason?: string) {
	toastCalls.length = 0;
	toastOpts.length = 0;
	createPullRequest.mockResolvedValue({ delivery: { status, ...(reason ? { reason } : {}) } });
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

	// The user who clicked is usually watching that very terminal; the host drops it then.
	it("lets a successful handoff stay quiet while its task is in view", async () => {
		await createPRWithVerdict("delivered");
		expect(toastOpts).toEqual([{ taskId: "task-1", quietWhileTaskInView: true }]);
	});

	it("never quiets an unconfirmed or failed handoff", async () => {
		for (const status of ["unconfirmed", "not-delivered"] as const) {
			await createPRWithVerdict(status);
			expect(toastOpts[0]).toEqual({ taskId: "task-1" });
		}
		createPullRequest.mockRejectedValue(new Error("boom"));
		toastOpts.length = 0;
		const { result } = renderHook(
			() => useTaskBranchStatus({ task, project, dispatch: vi.fn(), navigate: vi.fn(), isTaskActive: true, enabled: false }),
			{ wrapper },
		);
		await act(() => result.current.handleCreatePR(false));
		expect(toastOpts).toEqual([{ taskId: "task-1" }]);
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

	// dev3 refused on purpose: typing the hand-off would have submitted the stranded peer
	// message together with the user's draft. The terminal is there; saying otherwise is false.
	it("names a stranded peer message, not a missing terminal, when the box is occupied", async () => {
		const calls = await createPRWithVerdict("not-delivered", "input-occupied");
		expect(calls).toEqual([
			{ level: "error", message: "A peer message is waiting unsent in the agent's input box. Press Enter there, then try again" },
		]);
	});

	it("keeps the no-terminal message for every other refusal reason", async () => {
		const calls = await createPRWithVerdict("not-delivered", "pane-absent");
		expect(calls).toEqual([{ level: "error", message: "No agent terminal found to hand PR creation to" }]);
	});

	it("gives the commit hand-off the same occupied-box message", async () => {
		toastCalls.length = 0;
		commitTaskViaAgent.mockResolvedValue({ delivery: { status: "not-delivered", reason: "input-occupied" } });
		const { result } = renderHook(
			() => useTaskBranchStatus({ task, project, dispatch: vi.fn(), navigate: vi.fn(), isTaskActive: true, enabled: false }),
			{ wrapper },
		);
		await act(() => result.current.handleCommit());
		expect(toastCalls).toEqual([
			{ level: "error", message: "A peer message is waiting unsent in the agent's input box. Press Enter there, then try again" },
		]);
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
