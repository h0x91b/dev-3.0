import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { RPC_STATUS_EVENT } from "../../diagnostics";
import type { Route } from "../../state";
import { RouteHost } from "../../test-utils/route-host";
import ProjectView from "../ProjectView";
import { api } from "../../rpc";
import { toast } from "../../toast";

// Mutable so a test can flip to remote/browser mode; a getter proves the layout
// no longer branches on it (regression guard for #992 over-hiding the sidebar).
const rpcMock = vi.hoisted(() => ({ isElectrobun: true }));
vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTasks: vi.fn().mockResolvedValue([]),
			getAgents: vi.fn().mockResolvedValue([]),
			getSpaces: vi.fn().mockResolvedValue({ version: 1, spaces: [], order: [] }),
		},
	},
	get isElectrobun() {
		return rpcMock.isElectrobun;
	},
	getRpcConnectionState: () => "connected",
	reconnectRpc: vi.fn(),
}));

// Heavy children — stub so the test focuses on ProjectView's own layout logic.
vi.mock("../KanbanBoard", () => ({
	default: ({ onOpenUnresolvedComments }: { onOpenUnresolvedComments?: (task: Task) => void }) => (
		<div data-testid="kanban">
			<button type="button" data-testid="open-unresolved-from-board" onClick={() => onOpenUnresolvedComments?.({ id: "t1" } as Task)} />
		</div>
	),
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("../TaskInfoPanel", () => ({ default: () => <div data-testid="info-panel" /> }));
vi.mock("../ActiveTasksSidebar", () => ({ default: () => <div data-testid="sidebar" /> }));
vi.mock("../TaskWorkspacePane", () => ({
	default: ({ inlineDiffRequest }: { inlineDiffRequest?: { focusFirstUnresolvedThread?: boolean } }) => (
		<div data-testid="workspace">
			{inlineDiffRequest?.focusFirstUnresolvedThread && <span data-testid="workspace-unresolved-diff" />}
		</div>
	),
}));
vi.mock("../SplitLayout", () => ({
	default: (props: { kanbanContent: React.ReactNode; terminalContent: React.ReactNode }) => (
		<div>
			<div data-testid="left">{props.kanbanContent}</div>
			<div data-testid="right">{props.terminalContent}</div>
		</div>
	),
}));

const project: Project = {
	id: "p1",
	name: "Alpha",
	path: "/a",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "",
};

function renderView(props: Partial<React.ComponentProps<typeof ProjectView>>) {
	const tasks: Task[] = props.tasks ?? [];
	// The inline diff lives on the route, so drive the view with the real reducer.
	const route: Route = props.route ?? {
		screen: "project",
		projectId: "p1",
		activeTaskId: props.activeTaskId,
		taskView: props.taskView,
	};
	return render(
		<I18nProvider>
			<RouteHost
				route={route}
				element={
					<ProjectView
						projectId="p1"
						projects={[project]}
						tasks={tasks}
						dispatch={vi.fn()}
						route={route}
						navigate={vi.fn()}
						bellCounts={new Map()}
						taskPorts={new Map()}
						taskDevServers={new Map()}
						{...props}
					/>
				}
			/>
		</I18nProvider>,
	);
}

describe("ProjectView task-view layout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rpcMock.isElectrobun = true;
		localStorage.removeItem("dev3-task-open-mode");
	});

	it("does not replace a pushed scheduled task with an older initial task snapshot", async () => {
		let resolveTasks: (tasks: Task[]) => void;
		const pendingTasks = new Promise<Task[]>((resolve) => {
			resolveTasks = resolve;
		});
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks).mockReturnValueOnce(pendingTasks);
		const dispatch = vi.fn();

		renderView({ dispatch });
		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledWith({ projectId: "p1" }));

		window.dispatchEvent(new CustomEvent("rpc:taskUpdated", {
			detail: { task: { id: "scheduled-task", projectId: "p1" } },
		}));
		resolveTasks!([]);

		await Promise.resolve();
		expect(dispatch).not.toHaveBeenCalledWith({ type: "setTasks", projectId: "p1", tasks: [] });
		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: "setTasks",
				projectId: "p1",
				tasks: [{ id: "scheduled-task", projectId: "p1" }],
			}),
		);
	});

	// A push landing mid-fetch used to discard the entire snapshot, leaving the
	// board with only the pushed card until the view remounted (dashboard round trip).
	it("keeps the full snapshot when a task update lands mid-fetch", async () => {
		let resolveTasks: (tasks: Task[]) => void;
		const pendingTasks = new Promise<Task[]>((resolve) => {
			resolveTasks = resolve;
		});
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks).mockReturnValueOnce(pendingTasks);
		const dispatch = vi.fn();

		renderView({ dispatch });
		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledWith({ projectId: "p1" }));

		window.dispatchEvent(new CustomEvent("rpc:taskUpdated", {
			detail: { task: { id: "b", projectId: "p1", status: "in-progress" } },
		}));
		resolveTasks!([
			{ id: "a", projectId: "p1" } as Task,
			{ id: "b", projectId: "p1", status: "todo" } as Task,
			{ id: "c", projectId: "p1" } as Task,
		]);

		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: "setTasks",
				projectId: "p1",
				tasks: [
					{ id: "a", projectId: "p1" },
					{ id: "b", projectId: "p1", status: "in-progress" },
					{ id: "c", projectId: "p1" },
				],
			}),
		);
	});

	it("shows the empty-terminal placeholder when taskView is set but no task is selected", async () => {
		renderView({ taskView: true });
		await waitFor(() => expect(screen.getByTestId("sidebar")).toBeInTheDocument());
		expect(screen.getByText("Select a task to see its terminal")).toBeInTheDocument();
		expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
	});

	it("navigates back to the Kanban board from the empty-pane button (wide viewport)", async () => {
		const navigate = vi.fn();
		renderView({ taskView: true, navigate });
		await waitFor(() => expect(screen.getByText("Back to Kanban")).toBeInTheDocument());

		await userEvent.click(screen.getByText("Back to Kanban"));

		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
	});

	it("renders the task workspace (no placeholder) when a task is active", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
		expect(screen.queryByText("Select a task to see its terminal")).not.toBeInTheDocument();
	});

	it("keeps the active-tasks sidebar in remote/browser mode on a wide viewport", async () => {
		rpcMock.isElectrobun = false;
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("sidebar")).toBeInTheDocument());
		expect(screen.getByTestId("workspace")).toBeInTheDocument();
	});

	it("renders only the Kanban board when neither activeTaskId nor taskView is set", async () => {
		renderView({});
		await waitFor(() => expect(screen.getByTestId("kanban")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
		expect(screen.queryByText("Select a task to see its terminal")).not.toBeInTheDocument();
	});

	it("opens unresolved comments from Kanban in the configured split task route", async () => {
		const navigate = vi.fn();
		renderView({ navigate });
		await waitFor(() => expect(screen.getByTestId("kanban")).toBeInTheDocument());

		await userEvent.click(screen.getByTestId("open-unresolved-from-board"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "t1",
			openUnresolvedComments: true,
		});
	});

	it("uses the fullscreen task route when that open mode is configured", async () => {
		localStorage.setItem("dev3-task-open-mode", "fullscreen");
		const navigate = vi.fn();
		renderView({ navigate });
		await waitFor(() => expect(screen.getByTestId("kanban")).toBeInTheDocument());

		await userEvent.click(screen.getByTestId("open-unresolved-from-board"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "task",
			projectId: "p1",
			taskId: "t1",
			openUnresolvedComments: true,
		});
	});

	it("opens the inline diff when the split route carries the unresolved-comments flag", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress", baseBranch: "main", branchName: "feature/t1" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task], openUnresolvedComments: true });

		await waitFor(() => expect(screen.getByTestId("workspace-unresolved-diff")).toBeInTheDocument());
	});
});

describe("ProjectView board load states", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rpcMock.isElectrobun = false;
	});

	it("shows a skeleton instead of an empty board while the first fetch is in flight", async () => {
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks).mockReturnValueOnce(new Promise<Task[]>(() => {}));

		renderView({});

		await waitFor(() => expect(screen.getByTestId("kanban-skeleton")).toBeInTheDocument());
		expect(screen.queryByTestId("kanban")).not.toBeInTheDocument();
	});

	it("keeps showing cached tasks while a refetch is in flight", async () => {
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks).mockReturnValueOnce(new Promise<Task[]>(() => {}));
		const task = { id: "t1", projectId: "p1", title: "T", status: "todo" } as unknown as Task;

		renderView({ tasks: [task] });

		expect(screen.getByTestId("kanban")).toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(screen.queryByTestId("kanban-skeleton")).not.toBeInTheDocument();
	});

	it("surfaces a retry panel when the fetch fails, and refetches on retry", async () => {
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks)
			.mockRejectedValueOnce(new Error("RPC connection closed"))
			.mockResolvedValueOnce([]);

		renderView({});

		await waitFor(() => expect(screen.getByTestId("board-load-failed")).toBeInTheDocument());
		await userEvent.click(screen.getByText("Retry"));

		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByTestId("kanban")).toBeInTheDocument());
	});

	it("refetches tasks by itself once the transport reconnects", async () => {
		const { api } = await import("../../rpc");
		renderView({});
		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledTimes(1));

		act(() => {
			window.dispatchEvent(new CustomEvent(RPC_STATUS_EVENT, { detail: { state: "reconnecting" } }));
		});
		act(() => {
			window.dispatchEvent(new CustomEvent(RPC_STATUS_EVENT, { detail: { state: "connected" } }));
		});

		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledTimes(2));
	});
});

describe("ProjectView narrow viewport (mobile zoom)", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		rpcMock.isElectrobun = true;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("zooms the task workspace and hides the active-tasks sidebar", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
		expect(screen.getByTestId("info-panel")).toBeInTheDocument();
	});

	it("still hides the sidebar in remote/browser mode when the viewport is narrow", async () => {
		rpcMock.isElectrobun = false;
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
	});

	it("redirects the useless empty task pane back to Kanban", async () => {
		const navigate = vi.fn();
		renderView({ taskView: true, navigate });
		await waitFor(() => expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" }));
	});
});


// ---- A board whose subject is a space ----

describe("ProjectView — space as the subject", () => {
	const web: Project = { ...project, id: "p2", name: "web", path: "/w" };
	const space = { id: "sp_1", name: "Client X", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 };

	function renderSpaceView(spaces: unknown[], navigate = vi.fn()) {
		vi.mocked(api.request.getSpaces).mockResolvedValue({ version: 1, spaces, order: ["sp_1"] } as never);
		const route: Route = { screen: "project", projectId: "p1", spaceId: "sp_1" };
		render(
			<I18nProvider>
				<RouteHost
					route={route}
					element={
						<ProjectView
							projectId="p1"
							spaceId="sp_1"
							projects={[project, web]}
							tasks={[]}
							dispatch={vi.fn()}
							route={route}
							navigate={navigate}
							bellCounts={new Map()}
							taskPorts={new Map()}
							taskDevServers={new Map()}
						/>
					}
				/>
			</I18nProvider>,
		);
		return { navigate };
	}

	beforeEach(() => {
		vi.mocked(api.request.getTasks).mockClear();
		vi.mocked(toast.info).mockClear();
	});

	// Spaces arrive over RPC, so the board briefly shows the anchor alone and then
	// widens; what matters is that it ends up fetching every member.
	it("fetches one snapshot per member project", async () => {
		renderSpaceView([space]);
		await waitFor(() => {
			const ids = [...new Set(vi.mocked(api.request.getTasks).mock.calls.map((call) => call[0].projectId))].sort();
			expect(ids).toEqual(["p1", "p2"]);
		});
	});

	// A route that lost its subject is the same class as a deleted task: leave for
	// the dashboard and say why, rather than render a board about nothing.
	it("lands on the dashboard with a toast when the space is gone", async () => {
		const { navigate } = renderSpaceView([]);
		await waitFor(() => expect(navigate).toHaveBeenCalledWith({ screen: "dashboard" }));
		expect(toast.info).toHaveBeenCalled();
	});

	it("a renamed space is not a disappearance — the user stays put", async () => {
		const { navigate } = renderSpaceView([{ ...space, name: "Client Y" }]);
		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalled());
		expect(navigate).not.toHaveBeenCalledWith({ screen: "dashboard" });
		expect(toast.info).not.toHaveBeenCalled();
	});
});
