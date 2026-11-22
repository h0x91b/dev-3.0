import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import TaskTerminal from "../TaskTerminal";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import { getAppRoot } from "../../plugins/root";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../../task-header/builtins";
import type { Project, Task } from "../../../shared/types";

// The real header next to the real terminal wrapper: only TerminalView is replaced, by a render counter.
vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPtyUrl: vi.fn().mockResolvedValue({ url: "ws://pty/1" }),
			checkWorktreeState: vi.fn().mockResolvedValue({ ok: true }),
			getResolvedProject: vi.fn(),
			getBranchStatus: vi.fn().mockResolvedValue({ ahead: 0, behind: 0, insertions: 0, deletions: 0, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileStats: [] }),
			refreshTaskPrStatus: vi.fn().mockResolvedValue({ outcome: "updated" }),
			getPortAllocations: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({}),
			getDevServerStatus: vi.fn().mockResolvedValue(null),
			checkDevServer: vi.fn().mockResolvedValue(null),
			getAvailableApps: vi.fn().mockResolvedValue([]),
			taskPaneState: vi.fn().mockResolvedValue({ backend: "tmux", panes: [], activePaneId: null, zoomedPaneId: null, layout: null, layoutPreset: null, capabilities: [] }),
			prepareMergeCompletionPrompt: vi.fn().mockResolvedValue({ shouldPrompt: false }),
			getTaskLineage: vi.fn().mockResolvedValue(null),
			getEpics: vi.fn().mockResolvedValue([]),
		},
	},
	isElectrobun: false,
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

vi.mock("../../hooks/useAgents", () => ({
	useAgents: () => [{ id: "builtin-claude", baseCommand: "claude", configurations: [] }],
}));

let terminalViewRenders = 0;
vi.mock("../../TerminalView", () => ({
	default: () => {
		terminalViewRenders++;
		return <div data-testid="terminal-view" />;
	},
}));

import { api } from "../../rpc";

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const task: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Test task",
	description: "",
	status: "in-progress",
	baseBranch: "main",
	worktreePath: "/tmp/wt/t1",
	branchName: "dev3/task-t1",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2025-06-15T10:30:00Z",
	updatedAt: "2025-06-15T12:00:00Z",
};

applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);

describe("TaskTerminal with the real TaskHeader", () => {
	it("does not re-render TerminalView when the header changes on its own", async () => {
		vi.mocked(api.request.getResolvedProject).mockResolvedValue(project);
		localStorage.clear();
		await act(async () => {
			render(
				<I18nProvider>
					<TaskTerminal projectId="p1" taskId="t1" tasks={[task]} projects={[project]} navigate={vi.fn()} dispatch={vi.fn()} />
				</I18nProvider>,
			);
		});
		await screen.findByTestId("terminal-view");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const settled = terminalViewRenders;

		fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
		fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
		const probe = getAppRoot().plugin({
			name: "terminal-render-probe",
			inject: ["taskHeader"],
			apply(ctx: Context) {
				ctx.taskHeader.register({ id: "builtin:runtime.render-probe", region: "runtime", label: "taskHeaderItem.status.watch", component: () => <span data-testid="render-probe" /> });
			},
		});
		await act(async () => {
			await probe;
		});

		expect(screen.getByTestId("render-probe")).toBeInTheDocument();
		expect(terminalViewRenders).toBe(settled);
		await act(async () => {
			await probe.dispose();
		});
	});
});
