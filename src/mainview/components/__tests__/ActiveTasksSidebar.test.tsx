import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import ActiveTasksSidebar from "../ActiveTasksSidebar";
import type { CodingAgent, Project, Task } from "../../../shared/types";

const terminalPreview = vi.hoisted(() => ({
	close: vi.fn(),
	handlers: {
		onMouseEnter: vi.fn(),
		onMouseLeave: vi.fn(),
	},
	state: {
		open: false,
		html: null,
		loading: false,
		pos: { top: 0, left: 0 },
		activeTaskId: null,
		cancelClose: vi.fn(),
		scheduleClose: vi.fn(),
	},
}));

vi.mock("../../hooks/useTerminalPreview", () => ({
	useTerminalPreview: () => terminalPreview,
}));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTerminalPreview: vi.fn(),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			setTaskPriority: vi.fn(() => Promise.resolve([])),
			// Feature-discovery tip rotation (useTipRotation).
			getGlobalSettings: vi.fn(() => Promise.resolve({ tipsDisabled: true })),
			getTipState: vi.fn(() => Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0 })),
			updateTipState: vi.fn((s) => Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0, ...s })),
		},
	},
}));

beforeEach(() => {
	localStorage.removeItem("dev3-sidebar-scope");
	terminalPreview.close.mockClear();
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
	it("shows teardown feedback and blocks a shutting-down task", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ shuttingDown: true })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={navigate}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const status = screen.getByRole("status");
		expect(status).toHaveAttribute("aria-busy", "true");
		expect(screen.getByText("Shutting down…")).toBeInTheDocument();
		expect(screen.getByText("Closing session & worktree")).toBeInTheDocument();

		await user.click(screen.getByText("Привет! как сам?"));
		expect(navigate).not.toHaveBeenCalled();
	});

	it("marks a task whose session died and sinks it under the live ones", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({
							id: "dead",
							title: "Dead session",
							priority: "P0",
							runtimeState: { runtime: "idle", updatedAt: 1 },
						}),
						makeTask({ id: "live", title: "Live session", priority: "P4" }),
					]}
					activeTaskId={undefined}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		expect(screen.getByTestId("sidebar-disconnected-badge")).toHaveTextContent(/disconnected/i);
		const live = screen.getByText("Live session");
		const dead = screen.getByText("Dead session");
		expect(live.compareDocumentPosition(dead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("returns to the Kanban board when the focused task is clicked again", async () => {
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
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByText("Привет! как сам?"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
		expect(terminalPreview.close).toHaveBeenCalledTimes(1);
	});

	it("shows agent-first identity with compact config and variant dots", () => {
		const navigate = vi.fn();
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
					navigate={navigate}
					agents={[claudeAgent, codexAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		expect(screen.getByRole("img", { name: "Claude" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Codex" })).toBeInTheDocument();
		expect(screen.getByText("Claude · Opus 4.7 · Bypass")).toBeInTheDocument();
		expect(screen.getByText("Codex · GPT-5.5 Heavy Bypass")).toBeInTheDocument();
		expect(screen.getByTestId("variant-indicator-t1")).toBeInTheDocument();
		// The config line is the row's LAST line now — the title leads, and the
		// agent identity is a muted tail below the signals.
		const identity = screen.getByTestId("sidebar-identity-t1");
		expect(identity).toHaveTextContent("Claude · Opus 4.7 · Bypass");
		const title = within(screen.getByTestId("sidebar-status-rail-t1").parentElement!).getByText("Привет! как сам?");
		expect(title.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getAllByText("#494")).toHaveLength(2);
	});

	it("does not activate the task when the dots button receives keyboard input", async () => {
		const navigate = vi.fn();
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask(), makeTask({ id: "t2", variantIndex: 2 })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={navigate}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const dots = screen.getByTestId("variant-indicator-t1");
		dots.focus();
		await user.keyboard(" ");

		expect(navigate).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Siblings" })).toBeInTheDocument();
	});

	it("closes the terminal preview before opening the sibling overview", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask(), makeTask({ id: "t2", variantIndex: 2 })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByTestId("variant-indicator-t1"));

		expect(terminalPreview.close).toHaveBeenCalledTimes(1);
	});

	it("mounts the Kanban lifecycle rail on every row, tinted with the task's status color", () => {
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
				/>
			</I18nProvider>,
		);

		// Same component as the board — one lifecycle vocabulary across surfaces.
		const activeRail = screen.getByTestId("sidebar-status-rail-t1");
		const inactiveRail = screen.getByTestId("sidebar-status-rail-t2");
		expect(within(activeRail).getByTestId("task-card-rail")).toBeInTheDocument();
		expect(within(inactiveRail).getByTestId("task-card-rail")).toBeInTheDocument();

		// Each rail is tinted with its OWN status hue, inline (the documented
		// STATUS_COLORS hex exception), and names the status uprightly.
		expect(within(activeRail).getByTestId("task-card-rail").getAttribute("style") ?? "").toContain("#afbaff");
		expect(within(inactiveRail).getByTestId("task-card-rail").getAttribute("style") ?? "").toContain("#ffe55f");
		// Ring yes, stacked word no — an upright letter would set the row height
		// instead of describing it. The name lives in the tooltip and aria-label.
		expect(within(activeRail).getByRole("img", { name: "Stage 2 of 7" })).toBeInTheDocument();
		expect(within(inactiveRail).getByRole("img", { name: "Stage 5 of 7" })).toBeInTheDocument();
		expect(activeRail.querySelector("[class*=vertical-rl]")).toBeNull();
		expect(inactiveRail.querySelector("[class*=vertical-rl]")).toBeNull();

		// The busy sheen rides only the working row, never the review one.
		expect(activeRail.querySelector(".animate-rail-flow")).not.toBeNull();
		expect(inactiveRail.querySelector(".animate-rail-flow")).toBeNull();
	});

	it("opens the same Move-to menu as the board when the rail's ring is clicked", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", status: "in-progress" })]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const rail = screen.getByTestId("sidebar-status-rail-t1");
		await user.click(within(rail).getByRole("button", { name: /Stage 2 of 7\. Move to/i }));

		expect(screen.getByText("Your Review")).toBeInTheDocument();
	});

	it("does not navigate to the task when the rail is clicked", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", status: "in-progress" })]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={navigate}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const rail = screen.getByTestId("sidebar-status-rail-t1");
		await user.click(within(rail).getByRole("button", { name: /Stage 2 of 7\. Move to/i }));

		expect(navigate).not.toHaveBeenCalled();
	});

	it("carries the attention bell inside the rail instead of over the row's text", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", status: "user-questions" })]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map([["t1", 3]])}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const rail = screen.getByTestId("sidebar-status-rail-t1");
		const bell = within(rail).getByTestId("task-card-rail-bell");
		expect(bell).toHaveTextContent("3");
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

	it("falls back to the project scope when localStorage holds the removed attention value", () => {
		localStorage.setItem("dev3-sidebar-scope", "attention");
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
				/>
			</I18nProvider>,
		);
		expect(screen.getByTestId("sidebar-scope-project")).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByTestId("sidebar-scope-attention")).not.toBeInTheDocument();
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
				/>
			</I18nProvider>,
		);

		expect(screen.queryByTestId("sidebar-hide")).not.toBeInTheDocument();
	});

	it("shows a compact status-age badge with a descriptive tooltip", async () => {
		const user = userEvent.setup();
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
				/>
			</I18nProvider>,
		);

		const badge = screen.getByTestId("sidebar-status-age-t1");
		expect(badge).toHaveTextContent("5m");
		await user.hover(badge);
		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip).toHaveTextContent("Status changed");
		expect(tooltip).toHaveTextContent("5m ago");
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
				/>
			</I18nProvider>,
		);

		expect(screen.queryByTestId("sidebar-status-age-t1")).not.toBeInTheDocument();
	});

	it("groups custom-column tasks under their own column, not their underlying status", () => {
		const projectWithCol: Project = {
			...project,
			customColumns: [
				{ id: "col-hold", name: "On hold", color: "#abcdef", llmInstruction: "" },
			],
		};
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={projectWithCol}
					tasks={[
						// Active task in a built-in status column.
						makeTask({
							id: "plain", status: "review-by-user",
							title: "Plain review task", description: "Plain review task",
							groupId: null as unknown as string, variantIndex: null,
						}),
						// Task parked in the custom "On hold" column. Its underlying
						// status is still review-by-user, but it must NOT show under
						// "Your Review" — it belongs to the custom column group.
						makeTask({
							id: "parked", status: "review-by-user", customColumnId: "col-hold",
							title: "Parked task", description: "Parked task",
							groupId: null as unknown as string, variantIndex: null,
						}),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		// Both tasks are visible.
		expect(screen.getByText("Plain review task")).toBeInTheDocument();
		expect(screen.getByText("Parked task")).toBeInTheDocument();

		// A custom-column group header with the column name is rendered.
		const holdHeader = screen.getByText("On hold");
		expect(holdHeader).toBeInTheDocument();

		// The custom-column tier sits AFTER the built-in "Needs you" tier, and the
		// parked task lives below the "On hold" header — not in the NEEDS YOU tier
		// with the plain task. (Its actionable status does NOT override its column.)
		const needsYou = screen.getByText("Needs you");
		const plain = screen.getByText("Plain review task");
		const parked = screen.getByText("Parked task");
		// Order in the DOM: Needs you → Plain task → On hold → Parked task.
		expect(needsYou.compareDocumentPosition(holdHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(plain.compareDocumentPosition(holdHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(holdHeader.compareDocumentPosition(parked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// The parked card's rail carries the custom column color, not the
		// review-by-user status hue.
		const parkedRail = within(screen.getByTestId("sidebar-status-rail-parked")).getByTestId("task-card-rail");
		expect((parkedRail.getAttribute("style") ?? "").toLowerCase()).toContain("#abcdef");
	});

	it("orders tasks within a group oldest-first by movedAt (longest-waiting on top)", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						// Intentionally provided newest-first to prove the sidebar sorts,
						// not just preserves array order.
						makeTask({
							id: "fresh", status: "review-by-user",
							title: "Fresh task", description: "Fresh task",
							groupId: null as unknown as string, variantIndex: null,
							movedAt: "2026-06-22T14:00:00Z",
						}),
						makeTask({
							id: "stale", status: "review-by-user",
							title: "Stale task", description: "Stale task",
							groupId: null as unknown as string, variantIndex: null,
							movedAt: "2026-06-22T13:13:00Z",
						}),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		const stale = screen.getByText("Stale task");
		const fresh = screen.getByText("Fresh task");
		// Oldest (stale, 13:13) sits ABOVE the newer (fresh, 14:00).
		expect(stale.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("renders the token-DSL filter funnel and its operators HelpSpot", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", status: "in-progress" })]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByTestId("filter-funnel-button")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "About this section" })).toBeInTheDocument();
	});

	it("typing a facet token filters the task list", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "a", title: "Alpha task", description: "Alpha", status: "in-progress", agentId: "builtin-claude", configId: "claude-bypass", groupId: null as unknown as string, variantIndex: null }),
						makeTask({ id: "b", title: "Beta task", description: "Beta", status: "in-progress", agentId: "builtin-codex", configId: "codex-default", groupId: null as unknown as string, variantIndex: null }),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent, codexAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("Alpha task")).toBeInTheDocument();
		expect(screen.getByText("Beta task")).toBeInTheDocument();

		await user.type(screen.getByPlaceholderText("Search tasks..."), "agent:Codex");
		expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();
		expect(screen.getByText("Beta task")).toBeInTheDocument();
	});

	it("checking a funnel value reflects in the string and filters the list", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "a", title: "Alpha task", description: "Alpha", status: "in-progress", agentId: "builtin-claude", configId: "claude-bypass", groupId: null as unknown as string, variantIndex: null }),
						makeTask({ id: "b", title: "Beta task", description: "Beta", status: "review-by-user", agentId: "builtin-claude", configId: "claude-bypass", groupId: null as unknown as string, variantIndex: null }),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByTestId("filter-funnel-button"));
		// STATUS group only offers active statuses the sidebar shows — "To Do"
		// (an inactive status) is never a candidate.
		expect(screen.queryByRole("checkbox", { name: "To Do" })).not.toBeInTheDocument();
		await user.click(screen.getByRole("checkbox", { name: "Your Review" }));

		// The Your Review token now filters the list to the review task only.
		expect(screen.getByText("Beta task")).toBeInTheDocument();
		expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();
	});

	it("resets the filter on unmount (ephemeral, component state)", async () => {
		const user = userEvent.setup();
		const tasks = [
			makeTask({ id: "a", title: "Alpha task", description: "Alpha", status: "in-progress", groupId: null as unknown as string, variantIndex: null }),
			makeTask({ id: "b", title: "Beta task", description: "Beta", status: "in-progress", agentId: "builtin-codex", configId: "codex-default", groupId: null as unknown as string, variantIndex: null }),
		];
		const props = {
			project,
			tasks,
			activeTaskId: "none",
			dispatch: vi.fn(),
			navigate: vi.fn(),
			agents: [claudeAgent, codexAgent],
			bellCounts: new Map<string, number>(),
			taskPorts: new Map(),
		};
		const { unmount } = render(
			<I18nProvider>
				<ActiveTasksSidebar {...props} />
			</I18nProvider>,
		);
		await user.type(screen.getByPlaceholderText("Search tasks..."), "agent:Codex");
		expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();

		unmount();
		render(
			<I18nProvider>
				<ActiveTasksSidebar {...props} />
			</I18nProvider>,
		);
		// Fresh mount → the search string is empty again, all tasks visible.
		expect(screen.getByPlaceholderText("Search tasks...")).toHaveValue("");
		expect(screen.getByText("Alpha task")).toBeInTheDocument();
		expect(screen.getByText("Beta task")).toBeInTheDocument();
	});

	// A task that predates status-time tracking has no statusEnteredAt and no
	// movedAt; it falls back to createdAt rather than collapsing into one
	// indistinguishable "forever ago" block at either end of the tier.
	it("falls back to createdAt for a task with no status or move stamp", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({
							id: "no-moved", status: "review-by-user",
							title: "No timestamp", description: "No timestamp",
							groupId: null as unknown as string, variantIndex: null,
							movedAt: undefined,
							createdAt: "2024-01-01T00:00:00Z",
						}),
						makeTask({
							id: "has-moved", status: "review-by-user",
							title: "Has timestamp", description: "Has timestamp",
							groupId: null as unknown as string, variantIndex: null,
							movedAt: "2026-06-22T13:00:00Z",
						}),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		// Its 2024 createdAt is older than the other card's 2026 movedAt, so
		// oldest-first puts it on top.
		const hasMoved = screen.getByText("Has timestamp");
		const noMoved = screen.getByText("No timestamp");
		expect(noMoved.compareDocumentPosition(hasMoved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// ============================================================
	// Visible priority + readiness tiers (spec #1032)
	// ============================================================

	it("renders a priority badge on every card, including the default P3, with the heat-ramp color", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "hi", status: "review-by-user", priority: "P0" }),
						makeTask({ id: "default", status: "review-by-user", priority: undefined }),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		// A P0 badge (danger heat-ramp token) and a P3 badge (default, always shown).
		const p0 = screen.getByText("P0");
		expect(p0.className).toContain("text-danger");
		const p3 = screen.getByText("P3");
		expect(p3.className).toContain("text-success");
	});

	it("names each row's status in the rail's accessible name, not as visible text", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "q", status: "user-questions" }),
						makeTask({ id: "w", status: "in-progress" }),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		// On a short row the status reaches the user through the rail's
		// accessible name and tooltip, not as a stacked word.
		expect(within(screen.getByTestId("sidebar-status-rail-q")).getByRole("button", { name: /Has Questions/ })).toBeInTheDocument();
		expect(within(screen.getByTestId("sidebar-status-rail-w")).getByRole("button", { name: /Agent is Working/ })).toBeInTheDocument();
	});

	it("groups into readiness tiers with counted sticky headers", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask({ id: "r1", status: "review-by-user" }),
						makeTask({ id: "q1", status: "user-questions" }),
						makeTask({ id: "w1", status: "in-progress" }),
					]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		// Two built-in tiers, ordered NEEDS YOU → WAITING with correct counts.
		expect(screen.getByText("Needs you")).toBeInTheDocument();
		expect(screen.getByText("Waiting")).toBeInTheDocument();
		expect(screen.getByTestId("sidebar-tier-count-needs-you")).toHaveTextContent("2");
		expect(screen.getByTestId("sidebar-tier-count-waiting")).toHaveTextContent("1");
		const needsYou = screen.getByText("Needs you");
		const waiting = screen.getByText("Waiting");
		expect(needsYou.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("clicking the priority badge opens the picker without navigating to the task", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", status: "review-by-user", priority: "P2" })]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={navigate}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByText("P2"));
		// The picker (portal) lists the other levels, e.g. P0 — proving it opened.
		expect(screen.getByText("P0")).toBeInTheDocument();
		// Navigation must NOT have fired from the badge click.
		expect(navigate).not.toHaveBeenCalled();
	});

	it("changing priority from the badge calls setTaskPriority for the task's own project", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.setTaskPriority as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask({ id: "t1", projectId: "p1", status: "review-by-user", priority: "P2" })]}
					activeTaskId="none"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);

		await user.click(screen.getByText("P2"));
		await user.click(screen.getByText("P0"));
		expect(api.request.setTaskPriority).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "t1", projectId: "p1", priority: "P0" }),
		);
	});
});

describe("ActiveTasksSidebar — native terminal backend mark", () => {
	function renderSidebar(task: Task) {
		return render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[task]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
	}

	it("leads the identity line, before everything the agent owns", () => {
		renderSidebar(makeTask({ terminalBackend: "native", priority: "P2" }));

		const mark = screen.getByTestId("sidebar-native-backend-t1");
		const identity = screen.getByTestId("sidebar-identity-t1");
		// Position, not mere presence: the marker qualifies the task, so it opens
		// the identity line and precedes the agent badge.
		expect(identity.contains(mark)).toBe(true);
		expect(Array.from(identity.children).indexOf(mark)).toBe(0);
		const agentBadge = within(identity).getByRole("img", { name: "Claude" });
		expect(mark.compareDocumentPosition(agentBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// The row is a role=button with its own aria-label, which overrides every
	// descendant — so the marker only reaches assistive tech through that name.
	it("announces the backend in the row's accessible name", () => {
		renderSidebar(makeTask({ terminalBackend: "native" }));

		expect(
			screen.getByRole("button", { name: "Привет! как сам? — Native terminal backend" }),
		).toBeInTheDocument();
	});

	it("stays quiet for an explicit tmux task and for a legacy unmarked one", () => {
		const { unmount } = renderSidebar(makeTask({ terminalBackend: "tmux" }));
		expect(screen.queryByTestId("sidebar-native-backend-t1")).toBeNull();
		expect(screen.getByRole("button", { name: "Привет! как сам?" })).toBeInTheDocument();
		unmount();

		renderSidebar(makeTask());
		expect(screen.queryByTestId("sidebar-native-backend-t1")).toBeNull();
		expect(screen.getByRole("button", { name: "Привет! как сам?" })).toBeInTheDocument();
	});
});

describe("ActiveTasksSidebar — space scope", () => {
	const otherProject: Project = {
		id: "p2",
		name: "Sibling Project",
		path: "/tmp/sibling",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2025-01-01T00:00:00Z",
	};
	const strangerProject: Project = { ...otherProject, id: "p3", name: "Stranger Project", path: "/tmp/stranger" };

	function mockSpaces(projectIds: string[][]) {
		return {
			version: 1 as const,
			spaces: projectIds.map((ids, i) => ({
				id: `sp_${i}`,
				name: `Space ${i}`,
				parentId: null,
				projectIds: ids,
				createdAt: 1,
			})),
			order: projectIds.map((_, i) => `sp_${i}`),
		};
	}

	function renderSidebarWith(allProjects: Project[]) {
		return render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[makeTask()]}
					allProjects={allProjects}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
	}

	it("shows tasks only from projects sharing a space with the current one", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue(mockSpaces([["p1", "p2"]]));
		const siblingTask = makeTask({
			id: "t-sib", seq: 200, projectId: "p2",
			title: "Sibling task", description: "Sibling task",
			groupId: null as unknown as string, variantIndex: null,
		});
		const strangerTask = makeTask({
			id: "t-str", seq: 201, projectId: "p3",
			title: "Stranger task", description: "Stranger task",
			groupId: null as unknown as string, variantIndex: null,
		});
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
			{ projectId: "p2", tasks: [siblingTask] },
			{ projectId: "p3", tasks: [strangerTask] },
		]);

		renderSidebarWith([project, otherProject, strangerProject]);

		const spaceBtn = await screen.findByTestId("sidebar-scope-space");
		await waitFor(() => expect(spaceBtn).not.toHaveAttribute("aria-disabled"));
		await user.click(spaceBtn);

		await waitFor(() => expect(screen.getByText("Sibling task")).toBeInTheDocument());
		expect(screen.queryByText("Stranger task")).not.toBeInTheDocument();
		// Foreign rows carry the project badge.
		expect(screen.getByTestId("sidebar-project-badge-t-sib")).toHaveTextContent("Sibling Project");
		expect(localStorage.getItem("dev3-sidebar-scope")).toBe("space");
	});

	it("does not render the space button at all when no space exists", async () => {
		const { api } = await import("../../rpc");
		(api.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1, spaces: [], order: [] });
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
		]);
		renderSidebarWith([project]);
		// The switcher a user who never opted in sees: exactly yesterday's two.
		await waitFor(() => expect(screen.getByTestId("sidebar-scope-project")).toBeInTheDocument());
		expect(screen.getByTestId("sidebar-scope-global")).toBeInTheDocument();
		expect(screen.queryByTestId("sidebar-scope-space")).not.toBeInTheDocument();
	});

	it("tints only the selected scope with the accent pill", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue(mockSpaces([["p1", "p2"]]));
		renderSidebarWith([project, otherProject]);

		const projectBtn = await screen.findByTestId("sidebar-scope-project");
		expect(projectBtn.className).toContain("bg-accent/20");
		expect(screen.getByTestId("sidebar-scope-global").className).not.toContain("bg-accent/20");

		await user.click(screen.getByTestId("sidebar-scope-global"));
		await waitFor(() => expect(screen.getByTestId("sidebar-scope-global").className).toContain("bg-accent/20"));
		expect(screen.getByTestId("sidebar-scope-project").className).not.toContain("bg-accent/20");
	});

	it("disables the space button when spaces exist but the current project is in none", async () => {
		const { api } = await import("../../rpc");
		(api.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue(mockSpaces([["p2"]]));
		renderSidebarWith([project, otherProject]);
		const spaceBtn = await screen.findByTestId("sidebar-scope-space");
		await waitFor(() => expect(spaceBtn).toHaveAttribute("aria-disabled", "true"));
	});

	it("falls back to the project scope when the stored scope is space but the project has no memberships", async () => {
		const { api } = await import("../../rpc");
		(api.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue(mockSpaces([["p2"]]));
		localStorage.setItem("dev3-sidebar-scope", "space");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
		]);
		renderSidebarWith([project, otherProject]);
		// The project's own task list (the props-driven project scope) renders.
		await waitFor(() => expect(screen.getByText("Привет! как сам?")).toBeInTheDocument());
	});
});

describe("ActiveTasksSidebar — dashboard mount (no current project)", () => {
	function renderDashboardMount() {
		return render(
			<I18nProvider>
				<ActiveTasksSidebar
					allProjects={[project]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
	}

	it("hides the scope switcher and shows the across-all-spaces subtitle", async () => {
		const { api } = await import("../../rpc");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
		]);
		renderDashboardMount();
		await waitFor(() => expect(screen.getByText("Привет! как сам?")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar-scope-project")).not.toBeInTheDocument();
		expect(screen.queryByTestId("sidebar-scope-space")).not.toBeInTheDocument();
		expect(screen.queryByTestId("sidebar-scope-global")).not.toBeInTheDocument();
		expect(screen.getByText("Across all spaces")).toBeInTheDocument();
	});

	it("shows every project's tasks regardless of the stored scope", async () => {
		const { api } = await import("../../rpc");
		localStorage.setItem("dev3-sidebar-scope", "project");
		const other = makeTask({
			id: "t-other", seq: 7, projectId: "p9",
			title: "Other project task", description: "Other project task",
			groupId: null as unknown as string, variantIndex: null,
		});
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
			{ projectId: "p9", tasks: [other] },
		]);
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					allProjects={[project, { ...project, id: "p9", name: "Ninth" }]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByText("Other project task")).toBeInTheDocument());
		expect(screen.getByTestId("sidebar-project-badge-t-other")).toHaveTextContent("Ninth");
	});

	it("the presets preserve every other filter in the query", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask(), makeTask({ id: "t-rev", seq: 8, status: "review-by-user", title: "Waiting on you", description: "Waiting on you", groupId: null as unknown as string, variantIndex: null })] },
		]);
		renderDashboardMount();
		await waitFor(() => expect(screen.getByText("Waiting on you")).toBeInTheDocument());

		// A filter the user set by hand, unrelated to the presets.
		const search = screen.getByPlaceholderText("Search tasks...");
		await user.type(search, 'priority:P2 hello');

		await user.click(screen.getByTestId("sidebar-preset-attention"));
		expect((search as HTMLInputElement).value).toBe("priority:P2 hello is:attention");

		await user.click(screen.getByTestId("sidebar-preset-all"));
		expect((search as HTMLInputElement).value).toBe("priority:P2 hello");
	});

	it("a preset already in effect is a no-op rather than a query rewrite", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask()] },
		]);
		renderDashboardMount();
		const search = await screen.findByPlaceholderText("Search tasks...");
		await user.type(search, "space:Labs");

		await user.click(screen.getByTestId("sidebar-preset-all"));   // already "All"
		expect((search as HTMLInputElement).value).toBe("space:Labs");

		await user.click(screen.getByTestId("sidebar-preset-attention"));
		await user.click(screen.getByTestId("sidebar-preset-attention")); // already on
		expect((search as HTMLInputElement).value).toBe("space:Labs is:attention");
	});

	it("the Needs-you preset drives the is:attention token", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.getAllProjectTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask(), makeTask({ id: "t-rev", seq: 8, status: "review-by-user", title: "Waiting on you", description: "Waiting on you", groupId: null as unknown as string, variantIndex: null })] },
		]);
		renderDashboardMount();
		await waitFor(() => expect(screen.getByText("Waiting on you")).toBeInTheDocument());

		await user.click(screen.getByTestId("sidebar-preset-attention"));
		await waitFor(() => {
			expect(screen.getByText("Waiting on you")).toBeInTheDocument();
			expect(screen.queryByText("Привет! как сам?")).not.toBeInTheDocument();
		});
		await user.click(screen.getByTestId("sidebar-preset-all"));
		await waitFor(() => expect(screen.getByText("Привет! как сам?")).toBeInTheDocument());
	});
});
