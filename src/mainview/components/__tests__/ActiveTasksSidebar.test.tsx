import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import ActiveTasksSidebar from "../ActiveTasksSidebar";
import type { CodingAgent, Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTerminalPreview: vi.fn(),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
		},
	},
}));

beforeEach(() => {
	localStorage.removeItem("dev3-sidebar-scope");
});

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-bypass", name: "Bypass (Opus 4.7)" },
	],
	defaultConfigId: "claude-bypass",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default (GPT-5.4 Heavy Bypass)", model: "gpt-5.4" },
	],
	defaultConfigId: "codex-default",
};

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 494,
		projectId: "p1",
		title: "Привет! как сам?",
		description: "Привет! как сам?",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		groupId: "g1",
		variantIndex: 1,
		agentId: "builtin-claude",
		configId: "claude-bypass",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

describe("ActiveTasksSidebar", () => {
	it("shows agent-first identity with compact config and variant dots", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask(),
						makeTask({
							id: "t2",
							variantIndex: 2,
							agentId: "builtin-codex",
							configId: "codex-default",
						}),
					]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent, codexAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.getByRole("img", { name: "Claude" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Codex" })).toBeInTheDocument();
		expect(screen.getByText("Claude · Opus 4.7 · Bypass")).toBeInTheDocument();
		expect(screen.getByText("Codex · GPT-5.4 Heavy Bypass")).toBeInTheDocument();
		expect(screen.getByTestId("variant-indicator-t1")).toBeInTheDocument();
		expect(screen.getAllByText("#494")).toHaveLength(2);
	});

	it("toggles between project and global scope and fetches all-project tasks", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		const otherProject: Project = {
			id: "p2",
			name: "Other Project",
			path: "/tmp/other",
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			defaultBaseBranch: "main",
			createdAt: "2025-01-01T00:00:00Z",
		};
		const otherTask = makeTask({
			id: "t99",
			seq: 777,
			projectId: "p2",
			title: "Cross-project task",
			description: "Cross-project task",
			groupId: null as unknown as string,
			variantIndex: null,
		});
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
			{ projectId: "p2", tasks: [otherTask] },
		]);

		const navigate = vi.fn();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask()]}
					allProjects={[project, otherProject]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={navigate}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		// Cross-project task is hidden in project scope.
		expect(screen.queryByText("Cross-project task")).not.toBeInTheDocument();

		await user.click(screen.getByTestId("sidebar-scope-toggle"));

		await waitFor(() => {
			expect(screen.getByText("Cross-project task")).toBeInTheDocument();
		});
		expect(screen.getByTestId("sidebar-project-badge-t99")).toHaveTextContent("Other Project");
		expect(localStorage.getItem("dev3-sidebar-scope")).toBe("global");

		// Clicking cross-project task navigates to its home project.
		await user.click(screen.getByText("Cross-project task"));
		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p2",
			activeTaskId: "t99",
		});
	});

	it("does not hijack Cmd+F when disabled", async () => {
		const user = userEvent.setup();

		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask()]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
					disableGlobalFindShortcut
				/>
			</I18nProvider>,
		);

		const input = screen.getByPlaceholderText("Search tasks...");
		expect(input).not.toHaveFocus();
		await user.keyboard("{Meta>}f{/Meta}");
		expect(input).not.toHaveFocus();
	});
});
