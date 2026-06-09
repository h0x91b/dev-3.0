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
		{ id: "codex-default", name: "Default (GPT-5.5 Heavy Bypass)", model: "gpt-5.5" },
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
		expect(screen.getByText("Codex · GPT-5.5 Heavy Bypass")).toBeInTheDocument();
		expect(screen.getByTestId("variant-indicator-t1")).toBeInTheDocument();
		expect(screen.getAllByText("#494")).toHaveLength(2);
	});

	it("renders a per-card status color rail (status hue for inactive, accent for active)", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "t1", status: "in-progress" }),
						makeTask({
							id: "t2",
							status: "review-by-user",
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

		// Active task's rail uses the accent token, not a status hex.
		const activeRail = screen.getByTestId("sidebar-status-rail-t1");
		expect(activeRail.getAttribute("style") ?? "").toMatch(/box-shadow/i);
		expect(activeRail.querySelector("span")?.getAttribute("style") ?? "").toContain("var(--accent)");

		// Inactive task's rail is tinted inline with its status color.
		const inactiveRail = screen.getByTestId("sidebar-status-rail-t2");
		expect(inactiveRail.getAttribute("style") ?? "").not.toMatch(/box-shadow/i);
		expect(inactiveRail.querySelector("span")?.getAttribute("style") ?? "").toMatch(/background/);
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

		await user.click(screen.getByTestId("sidebar-scope-global"));

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

	it("attention scope shows only tasks needing user input, oldest-first, cross-project", async () => {
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
		const olderReview = makeTask({
			id: "rv-old", seq: 100, projectId: "p2",
			title: "Older review", description: "Older review",
			status: "review-by-user",
			groupId: null as unknown as string, variantIndex: null,
			updatedAt: "2025-01-01T00:00:00Z",
		});
		const newerReview = makeTask({
			id: "rv-new", seq: 101, projectId: "p1",
			title: "Newer review", description: "Newer review",
			status: "review-by-user",
			groupId: null as unknown as string, variantIndex: null,
			updatedAt: "2025-06-01T00:00:00Z",
		});
		const question = makeTask({
			id: "q1", seq: 102, projectId: "p1",
			title: "Has a question", description: "Has a question",
			status: "user-questions",
			groupId: null as unknown as string, variantIndex: null,
			updatedAt: "2025-03-01T00:00:00Z",
		});
		const working = makeTask({
			id: "w1", seq: 103, projectId: "p1",
			title: "Still working", description: "Still working",
			status: "in-progress",
			groupId: null as unknown as string, variantIndex: null,
		});
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [newerReview, question, working] },
			{ projectId: "p2", tasks: [olderReview] },
		]);

		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[working]}
					allProjects={[project, otherProject]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByTestId("sidebar-scope-attention"));

		await waitFor(() => {
			expect(screen.getByText("Older review")).toBeInTheDocument();
		});
		// in-progress task is excluded from attention scope
		expect(screen.queryByText("Still working")).not.toBeInTheDocument();
		// question task (other attention status) is included
		expect(screen.getByText("Has a question")).toBeInTheDocument();
		// oldest-first within the review-by-user group
		const older = screen.getByText("Older review");
		const newer = screen.getByText("Newer review");
		expect(
			older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(localStorage.getItem("dev3-sidebar-scope")).toBe("attention");
	});

	it("shows a count badge on the bell when tasks await input and attention scope is inactive", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "a1", status: "review-by-user" }),
						makeTask({ id: "a2", status: "user-questions" }),
						makeTask({ id: "a3", status: "in-progress" }),
					]}
					activeTaskId="a1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		// Two attention-status tasks → badge reads "2".
		expect(screen.getByTestId("sidebar-scope-attention")).toHaveTextContent("2");
	});

	it("shows the attention empty state when nothing needs the user's input", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask({ id: "w1", status: "in-progress" })] },
		]);

		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "w1", status: "in-progress" })]}
					activeTaskId="w1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByTestId("sidebar-scope-attention"));

		await waitFor(() => {
			expect(screen.getByText("Nothing needs your attention")).toBeInTheDocument();
		});
	});

	it("shows overview inline only for the active task when overview is set", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "t1", overview: "Fixing fork-branch fetch bug." }),
						makeTask({
							id: "t2",
							variantIndex: 2,
							agentId: "builtin-codex",
							configId: "codex-default",
							overview: "Other variant overview.",
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

		// Active task (t1) shows its overview inline
		expect(screen.getByTestId("active-task-overview-t1")).toHaveTextContent(
			"Fixing fork-branch fetch bug.",
		);
		// Inactive task (t2) does NOT render overview inline (even though it has one)
		expect(screen.queryByTestId("active-task-overview-t2")).toBeNull();
	});

	it("does not render overview block when overview is empty or whitespace", () => {
		const { rerender } = render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ overview: null })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("active-task-overview-t1")).toBeNull();

		rerender(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ overview: "   \n  " })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("active-task-overview-t1")).toBeNull();
	});

	it("shows user-edited overview instead of AI overview when both are set", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({
							id: "t1",
							overview: "AI-written summary the user doesn't want.",
							userOverview: "My hand-written version.",
						}),
					]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.getByTestId("active-task-overview-t1")).toHaveTextContent(
			"My hand-written version.",
		);
		expect(
			screen.queryByText("AI-written summary the user doesn't want."),
		).toBeNull();
	});

	it("falls back to AI overview when userOverview is null/empty", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({
							id: "t1",
							overview: "AI summary.",
							userOverview: null,
						}),
					]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByTestId("active-task-overview-t1")).toHaveTextContent(
			"AI summary.",
		);
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

	it("hides the sidebar by navigating to the full-page task view", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();

		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask()]}
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

		await user.click(screen.getByTestId("sidebar-hide"));
		expect(navigate).toHaveBeenCalledWith({ screen: "task", projectId: "p1", taskId: "t1" });
	});

	it("omits the hide button when no active task is set", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask()]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.queryByTestId("sidebar-hide")).not.toBeInTheDocument();
	});

	it("shows a compact status-age badge with a descriptive tooltip", () => {
		const movedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ movedAt })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		const badge = screen.getByTestId("sidebar-status-age-t1");
		expect(badge).toHaveTextContent("5m");
		expect(badge.getAttribute("title")).toContain("Status changed");
		expect(badge.getAttribute("title")).toContain("5m ago");
	});

	it("omits the status-age badge when movedAt is absent", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ movedAt: undefined })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.queryByTestId("sidebar-status-age-t1")).not.toBeInTheDocument();
	});
});
