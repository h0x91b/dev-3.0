import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalHeader from "../GlobalHeader";
import { I18nProvider } from "../../i18n";
import type { Project, Task, UpdateChangelog } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	// Browser mode: the fullscreen toggle row is visible in the action sheet.
	isElectrobun: false,
	api: {
		request: {
			getTasks: vi.fn(),
			applyUpdate: vi.fn(),
			saveLastRoute: vi.fn(),
			renameTask: vi.fn(),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			pullProjectMain: vi.fn(),
			getPreventSleepState: vi.fn().mockResolvedValue({ enabled: false, available: false, forcedByRemote: false }),
			setPreventSleep: vi.fn(),
			getAgentRateLimits: vi.fn().mockResolvedValue({ generatedAt: 0, snapshots: [] }),
			getRemoteAccessQR: vi.fn().mockResolvedValue({
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "http://192.168.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: true,
				interfaces: [],
				selectedHost: "192.168.0.1",
			}),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

vi.mock("../../toast", () => ({
	toast: {
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
	},
}));

import { api } from "../../rpc";
import { toast } from "../../toast";

const mockedApi = vi.mocked(api, true);

/**
 * Stub window.innerWidth + matchMedia for a given viewport width. Each
 * `(max-width: Npx)` query is evaluated against the width, so the compact
 * (1600) and narrow (768) breakpoints resolve independently — both read
 * matchMedia now, so a single shared boolean is not enough.
 */
function mockViewport(width: number) {
	Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: vi.fn((query: string) => {
			const m = query.match(/max-width:\s*(\d+)/);
			return {
				matches: m ? width <= Number(m[1]) : false,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			};
		}),
	});
}

/** compact (1600) but NOT narrow (768) when `true`; fully roomy when `false`. */
function mockMatchMedia(compact: boolean) {
	mockViewport(compact ? 1024 : 1920);
}

// Default to the roomy layout (labels visible). happy-dom's default viewport is
// 1024px, which would otherwise trip the compact breakpoint and hide labels.
beforeEach(() => mockMatchMedia(false));

const project1: Project = {
	id: "p1",
	name: "Project Alpha",
	path: "/home/user/alpha",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const project2: Project = {
	id: "p2",
	name: "Project Beta",
	path: "/home/user/beta",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-02T00:00:00Z",
};

const project3Deleted: Project = {
	id: "p3",
	name: "Deleted Project",
	path: "/home/user/deleted",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-03T00:00:00Z",
	deleted: true,
};

function renderHeader(
	route: Route,
	projects: Project[] = [project1, project2],
	navigate?: (route: Route) => void,
	tasks: Task[] = [],
	extra?: {
		updateVersion?: string | null;
		updateChangelog?: UpdateChangelog | null;
		updateDownloadStatus?: string | null;
		remoteAccessActive?: boolean;
		goBack?: () => void;
		goForward?: () => void;
		canGoBack?: boolean;
		canGoForward?: boolean;
	},
) {
	return render(
		<I18nProvider>
			<GlobalHeader
				route={route}
				projects={projects}
				tasks={tasks}
				navigate={navigate ?? vi.fn()}
				goBack={extra?.goBack ?? vi.fn()}
				goForward={extra?.goForward ?? vi.fn()}
				canGoBack={extra?.canGoBack ?? false}
				canGoForward={extra?.canGoForward ?? false}
				updateVersion={extra?.updateVersion}
				updateChangelog={extra?.updateChangelog}
				updateDownloadStatus={extra?.updateDownloadStatus}
				remoteAccessActive={extra?.remoteAccessActive ?? false}
			/>
		</I18nProvider>,
	);
}

function getChevronButton() {
	return screen.getByLabelText("Switch project");
}

describe("GlobalHeader — project switcher dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("shows chevron button next to project name when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		const chevron = getChevronButton();
		expect(chevron).toBeInTheDocument();
		// Project name text is rendered separately from the chevron
		expect(screen.getByText("Project Alpha")).toBeInTheDocument();
	});

	it("does not show project dropdown on dashboard", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.queryByLabelText("Switch project")).not.toBeInTheDocument();
	});

	it("project name click navigates to project board (restores from split view)", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1, project2],
			navigate,
			[{ id: "t1", seq: 1, title: "Task 1", status: "in-progress" } as Task],
		);

		// Click the project name text (not the chevron)
		await user.click(screen.getByText("Project Alpha"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});

	it("project name is clickable in activity/task view with no task selected", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader(
			{ screen: "project", projectId: "p1", taskView: true },
			[project1, project2],
			navigate,
		);

		// In task/activity view (taskView), the project name must navigate back to the kanban board
		await user.click(screen.getByText("Project Alpha"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});

	it("opens dropdown on chevron click and shows all non-deleted projects", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1, project2, project3Deleted],
		);

		await user.click(getChevronButton());

		// Both non-deleted projects should appear in the dropdown
		// Project Alpha appears twice: once in breadcrumb, once in dropdown
		expect(screen.getAllByText("Project Alpha")).toHaveLength(2);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Deleted project should not appear
		expect(screen.queryByText("Deleted Project")).not.toBeInTheDocument();
	});

	it("highlights the current project in the dropdown", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());

		// Find the dropdown buttons — the current project should have accent styling
		const alphaBtn = screen.getAllByRole("button").find(
			(b) => b.textContent?.includes("Project Alpha") && b.className.includes("bg-accent"),
		);
		expect(alphaBtn).toBeDefined();
	});

	it("navigates to selected project and closes dropdown", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);

		await user.click(getChevronButton());

		// Click on Project Beta in the dropdown
		const betaBtn = screen.getAllByRole("button").find(
			(b) => b.textContent?.includes("Project Beta"),
		);
		expect(betaBtn).toBeDefined();
		await user.click(betaBtn!);

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p2",
		});
	});

	it("closes dropdown on outside click", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());
		// Dropdown should be open — Project Beta is only visible in the dropdown
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Click outside
		await user.click(document.body);

		// Dropdown should close — Project Beta should no longer be visible
		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});

	it("closes dropdown on Escape key", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		await user.keyboard("{Escape}");

		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});

	it("fetches task counts when dropdown opens", async () => {
		const user = userEvent.setup();
		mockedApi.request.getTasks.mockImplementation(async ({ projectId }) => {
			if (projectId === "p1") {
				return [
					{ id: "t1", status: "in-progress" } as Task,
					{ id: "t2", status: "completed" } as Task,
				];
			}
			return [
				{ id: "t3", status: "in-progress" } as Task,
				{ id: "t4", status: "user-questions" } as Task,
				{ id: "t5", status: "review-by-user" } as Task,
			];
		});

		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(getChevronButton());

		// Wait for counts to load
		expect(await screen.findByText("1 active")).toBeInTheDocument();
		expect(await screen.findByText("3 active")).toBeInTheDocument();
	});

	it("shows 'No active tasks' for projects with zero active tasks", async () => {
		const user = userEvent.setup();
		mockedApi.request.getTasks.mockResolvedValue([
			{ id: "t1", status: "completed" } as Task,
		]);

		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(getChevronButton());

		expect(await screen.findAllByText("No active tasks")).toHaveLength(2);
	});

	it("shows downloading indicator when updateDownloadStatus is downloading", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "downloading" },
		);
		expect(screen.getByText("Downloading...")).toBeInTheDocument();
	});

	it("shows checking indicator when updateDownloadStatus is checking", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "checking" },
		);
		expect(screen.getByText("Checking...")).toBeInTheDocument();
	});

	it("does not show download indicator when updateVersion is set (ready state)", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3", updateDownloadStatus: "downloading" },
		);
		expect(screen.queryByText("Downloading...")).not.toBeInTheDocument();
		// Should show the "Update" ready button instead
		expect(screen.getByText("Update")).toBeInTheDocument();
	});

	it("does not show download indicator when status is error", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "error" },
		);
		expect(screen.queryByText("Downloading...")).not.toBeInTheDocument();
		expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
	});

	it("renders the what's-new changelog section in the update dropdown", async () => {
		const user = userEvent.setup();
		const changelog: UpdateChangelog = {
			features: ["Terminal scrollback search", "PR review threads in diff"],
			featureCount: 5,
			fixCount: 4,
		};
		renderHeader({ screen: "dashboard" }, [project1, project2], vi.fn(), [], {
			updateVersion: "1.38.0",
			updateChangelog: changelog,
		});

		await user.click(screen.getByRole("button", { name: /Version 1\.38\.0 is ready/i }));

		expect(screen.getByText("What's new in v1.38.0")).toBeInTheDocument();
		expect(screen.getByText("Terminal scrollback search")).toBeInTheDocument();
		expect(screen.getByText("PR review threads in diff")).toBeInTheDocument();
		// 5 total features, 2 shown → "+3 more features · 4 fixes"
		expect(screen.getByText("+3 more features · 4 fixes")).toBeInTheDocument();
	});

	it("navigates to the changelog screen from 'See all changes'", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "dashboard" }, [project1, project2], navigate, [], {
			updateVersion: "1.38.0",
			updateChangelog: { features: ["A feature"], featureCount: 1, fixCount: 0 },
		});

		await user.click(screen.getByRole("button", { name: /Version 1\.38\.0 is ready/i }));
		await user.click(screen.getByText(/See all changes/));
		expect(navigate).toHaveBeenCalledWith({ screen: "changelog" });
	});

	it("omits the what's-new section when no changelog is provided", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "dashboard" }, [project1, project2], vi.fn(), [], {
			updateVersion: "1.38.0",
		});
		await user.click(screen.getByRole("button", { name: /Version 1\.38\.0 is ready/i }));
		expect(screen.queryByText("What's new in v1.38.0")).not.toBeInTheDocument();
		// The dropdown still opened — its restart button (exact, no countdown suffix) is present.
		expect(screen.getByText("Restart to Update")).toBeInTheDocument();
	});

	it("toggles dropdown open/close on repeated chevron clicks", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		const chevron = getChevronButton();

		// Open
		await user.click(chevron);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Close
		await user.click(chevron);
		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});
});

describe("GlobalHeader — breadcrumb inline rename", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	const taskForRename: Task = {
		id: "t1",
		seq: 42,
		projectId: "p1",
		title: "My Task Title",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
	};

	it("shows pencil icon on hover for task segment in full-page view", () => {
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
		expect(screen.getByTitle("Edit title")).toBeInTheDocument();
	});

	it("shows pencil icon for task segment in split view", () => {
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
		expect(screen.getByTitle("Edit title")).toBeInTheDocument();
	});

	it("opens inline input on pencil click", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();
	});

	it("saves new title on Enter", async () => {
		const user = userEvent.setup();
		const updatedTask = { ...taskForRename, customTitle: "New Name" };
		mockedApi.request.renameTask.mockResolvedValue(updatedTask);

		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		const input = screen.getByDisplayValue("My Task Title");
		await user.clear(input);
		await user.type(input, "New Name{Enter}");

		expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
			taskId: "t1",
			projectId: "p1",
			customTitle: "New Name",
		});
	});

	it("cancels rename on cancel button click", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();

		await user.click(screen.getByTestId("rename-cancel"));
		expect(screen.queryByDisplayValue("My Task Title")).not.toBeInTheDocument();
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
	});

	it("does not save when title is unchanged", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		await user.keyboard("{Enter}");
		expect(mockedApi.request.renameTask).not.toHaveBeenCalled();
	});
});

describe("GlobalHeader — update countdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockedApi.request.getTasks.mockResolvedValue([]);
		mockedApi.request.applyUpdate.mockResolvedValue(undefined as any);
		mockedApi.request.saveLastRoute.mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows countdown on restart button when update is available", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/Restart to Update \(300s\)/)).toBeInTheDocument();
	});

	it("decrements countdown every second", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/\(300s\)/)).toBeInTheDocument();

		act(() => { vi.advanceTimersByTime(3000); });
		expect(screen.getByText(/\(297s\)/)).toBeInTheDocument();
	});

	it("shows Postpone button instead of Later", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText("Postpone")).toBeInTheDocument();
		expect(screen.queryByText("Later")).not.toBeInTheDocument();
	});

	it("dismisses toast and stops countdown on Postpone click", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/Restart to Update/)).toBeInTheDocument();

		act(() => { fireEvent.click(screen.getByText("Postpone")); });

		// Toast should be dismissed
		expect(screen.queryByText(/Restart to Update \(\d+s\)/)).not.toBeInTheDocument();
	});

	it("auto-restarts when countdown reaches 0", async () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { vi.advanceTimersByTime(300_000); });
		// Flush the async handleRestart (saveLastRoute → applyUpdate)
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(mockedApi.request.applyUpdate).toHaveBeenCalled();
	});

	it("shows an error toast and re-enables restart when applyUpdate fails (issue #813)", async () => {
		mockedApi.request.applyUpdate.mockRejectedValue(new Error("Update not ready to apply"));
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { fireEvent.click(screen.getByText(/Restart to Update \(\d+s\)/)); });
		// Flush the async handleRestart (saveLastRoute → applyUpdate rejection)
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Update not ready to apply"));
		// The UI must not stay stuck on "Restarting..."
		expect(screen.queryByText("Restarting...")).not.toBeInTheDocument();
	});

	it("saves current route via RPC before applying update", () => {
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { vi.advanceTimersByTime(300_000); });

		expect(mockedApi.request.saveLastRoute).toHaveBeenCalledWith({
			route: JSON.stringify({ screen: "project", projectId: "p1" }),
		});
	});
});

describe("GlobalHeader — project terminal button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("shows terminal button when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.getByText("Terminal")).toBeInTheDocument();
	});

	it("shows quick shell before project terminal", () => {
		renderHeader({ screen: "project", projectId: "p1" });

		const quickShellButton = screen.getByLabelText("Quick Shell \u2014 new scratch in Operations (\u2318\u21e7`)");
		const projectButton = screen.getByLabelText("Project Terminal (\u2318`)");

		expect(
			quickShellButton.compareDocumentPosition(projectButton) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders a Quick Shell icon (regression: was an empty placeholder)", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		// Migrated to Tooltip (aria-label, no native title) with an animated SVG icon.
		const quickShellButton = screen.getByLabelText("Quick Shell — new scratch in Operations (⌘⇧`)");
		const icon = quickShellButton.querySelector("svg");
		expect(icon).toBeTruthy();
		expect(quickShellButton.className).toContain("header-anim");
	});

	it("does not show terminal button on dashboard", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
	});

	it("terminal button has active style on project-terminal screen", () => {
		renderHeader({ screen: "project-terminal", projectId: "p1" });
		const btn = screen.getByLabelText("Project Terminal (\u2318`)");
		expect(btn.className).toContain("text-accent");
	});

	it("clicking terminal button navigates to project-terminal", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);
		await user.click(screen.getByLabelText("Project Terminal (\u2318`)"));
		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "p1",
		});
	});

	it("clicking terminal button when already on terminal navigates back to project", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project-terminal", projectId: "p1" }, [project1, project2], navigate);
		await user.click(screen.getByLabelText("Project Terminal (\u2318`)"));
		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});
});

describe("GlobalHeader — remote access indicator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("keeps the QR icon neutral until the tunnel is active", () => {
		renderHeader({ screen: "dashboard" });

		const remoteButton = screen.getByLabelText("Open on your phone — scan QR code for remote access");
		expect(remoteButton.className).not.toContain("remote-access-active");
		expect(remoteButton.querySelector(".hdr-qr1")).toBeInTheDocument();
	});

	it("uses the accent active state while the tunnel is connected", () => {
		renderHeader({ screen: "dashboard" }, undefined, undefined, [], { remoteAccessActive: true });

		const remoteButton = screen.getByLabelText("Open on your phone — scan QR code for remote access");
		expect(remoteButton.className).toContain("remote-access-active");
		expect(remoteButton.className).toContain("text-accent");
		expect(remoteButton.className).toContain("bg-accent/15");
	});
});

describe("GlobalHeader — compact layout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("hides button text labels when the viewport is narrow", () => {
		mockMatchMedia(true);
		renderHeader({ screen: "project", projectId: "p1" });
		// Buttons stay reachable by title, but their text labels collapse away.
		expect(screen.getByLabelText("Project Terminal (⌘`)")).toBeInTheDocument();
		expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
		expect(screen.queryByText("Report")).not.toBeInTheDocument();
		expect(screen.queryByText("Change Log")).not.toBeInTheDocument();
	});

	it("folds external actions into an overflow menu when narrow", async () => {
		mockMatchMedia(true);
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);

		const more = screen.getByLabelText("More");
		expect(more).toBeInTheDocument();

		await user.click(more);
		const changelogItem = screen.getByText("Change Log");
		await user.click(changelogItem);
		expect(navigate).toHaveBeenCalledWith({ screen: "changelog" });
	});

	it("keeps labels and folds changelog into the kebab when roomy", async () => {
		mockMatchMedia(false);
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		// Roomy layout keeps text labels (e.g. the project terminal's short
		// "Terminal" label). GitHub / Report / Changelog now always live in the
		// kebab ("More") menu — there is no standalone changelog button anymore,
		// so assert it via the opened menu instead.
		expect(screen.getByText("Terminal")).toBeInTheDocument();
		expect(screen.queryByLabelText("View changelog")).not.toBeInTheDocument();
		const more = screen.getByLabelText("More");
		await user.click(more);
		expect(screen.getByText("Change Log")).toBeInTheDocument();
	});
});

describe("GlobalHeader — help mode button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("renders the bright ? button on every screen", () => {
		mockMatchMedia(false);
		renderHeader({ screen: "dashboard" });
		expect(screen.getByTestId("header-help-mode")).toBeInTheDocument();
		expect(screen.getByLabelText("Explain this screen")).toBeInTheDocument();
	});

	it("stays inline even in compact layout (never folds into the kebab)", () => {
		mockMatchMedia(true);
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.getByTestId("header-help-mode")).toBeInTheDocument();
	});

	it("dispatches menu:enter-help-mode on click", async () => {
		mockMatchMedia(false);
		const user = userEvent.setup();
		const listener = vi.fn();
		window.addEventListener("menu:enter-help-mode", listener);
		try {
			renderHeader({ screen: "dashboard" });
			await user.click(screen.getByTestId("header-help-mode"));
			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener("menu:enter-help-mode", listener);
		}
	});
});

describe("GlobalHeader — back/forward navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("renders both navigation buttons", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.getByLabelText("Back (⌘[)")).toBeInTheDocument();
		expect(screen.getByLabelText("Forward (⌘])")).toBeInTheDocument();
	});

	it("disables back when there is no history behind", () => {
		renderHeader({ screen: "dashboard" }, undefined, undefined, [], { canGoBack: false });
		expect(screen.getByLabelText("Back (⌘[)")).toBeDisabled();
	});

	it("disables forward when there is no history ahead", () => {
		renderHeader({ screen: "dashboard" }, undefined, undefined, [], { canGoForward: false });
		expect(screen.getByLabelText("Forward (⌘])")).toBeDisabled();
	});

	it("invokes goBack when the back button is clicked", async () => {
		const user = userEvent.setup();
		const goBack = vi.fn();
		renderHeader({ screen: "dashboard" }, undefined, undefined, [], { canGoBack: true, goBack });
		await user.click(screen.getByLabelText("Back (⌘[)"));
		expect(goBack).toHaveBeenCalledTimes(1);
	});

	it("invokes goForward when the forward button is clicked", async () => {
		const user = userEvent.setup();
		const goForward = vi.fn();
		renderHeader({ screen: "dashboard" }, undefined, undefined, [], { canGoForward: true, goForward });
		await user.click(screen.getByLabelText("Forward (⌘])"));
		expect(goForward).toHaveBeenCalledTimes(1);
	});
});

describe("GlobalHeader — virtual (Operations) board git affordances", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	const virtualProject: Project = {
		...project1,
		id: "vp1",
		name: "Operations",
		kind: "virtual",
	};

	const builtinOps: Project = {
		...project1,
		id: "ops",
		name: "Operations",
		kind: "virtual",
		builtin: true,
	};

	it("shows the Pull button for a git project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.getByText("Pull")).toBeInTheDocument();
	});

	it("hides the Pull button for a virtual project", () => {
		renderHeader({ screen: "project", projectId: "vp1" }, [virtualProject]);
		expect(screen.queryByText("Pull")).not.toBeInTheDocument();
	});

	it("shows the bracketed board name in the breadcrumb for the built-in board", () => {
		renderHeader({ screen: "project", projectId: "ops" }, [project1, builtinOps]);
		expect(screen.getByText("[ Operations ]")).toBeInTheDocument();
	});

	it("pins the built-in board first in the switcher with a ⌘0 hint and SYSTEM badge", async () => {
		const user = userEvent.setup();
		// builtin passed LAST but must render FIRST in the dropdown.
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2, builtinOps]);
		await user.click(screen.getByLabelText("Switch project"));

		const rows = screen.getAllByRole("button").filter((b) => /Operations|Project Alpha|Project Beta/.test(b.textContent ?? ""));
		// First dropdown row is the pinned Operations board.
		expect(rows[0].textContent).toContain("[ Operations ]");
		expect(rows[0].textContent).toContain("⌘0");
		expect(rows[0].textContent).toContain("SYSTEM");
		// Ordinary projects keep ⌘1, ⌘2.
		expect(rows[1].textContent).toContain("⌘1");
		expect(rows[2].textContent).toContain("⌘2");
	});
});

describe("GlobalHeader — narrow viewport action sheet", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
		mockViewport(390);
	});

	afterEach(() => mockMatchMedia(false));

	it("folds the right-side cluster into a single kebab", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.getByLabelText("More")).toBeInTheDocument();
		// Inline simple-action buttons are gone (folded into the sheet).
		expect(screen.queryByLabelText("Project Terminal (⌘`)")).not.toBeInTheDocument();
	});

	it("opens a bottom sheet exposing the command palette and folded actions", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(screen.getByLabelText("More"));
		expect(screen.getByTestId("header-action-sheet")).toBeInTheDocument();
		expect(screen.getByText("Command palette")).toBeInTheDocument();
		expect(screen.getByText("Project Terminal")).toBeInTheDocument();
		expect(screen.getByText("Settings")).toBeInTheDocument();
	});

	it("command palette row dispatches the open-command-palette event", async () => {
		const user = userEvent.setup();
		const handler = vi.fn();
		window.addEventListener("menu:open-command-palette", handler);
		renderHeader({ screen: "dashboard" });
		await user.click(screen.getByLabelText("More"));
		await user.click(screen.getByText("Command palette"));
		expect(handler).toHaveBeenCalled();
		window.removeEventListener("menu:open-command-palette", handler);
	});

	it("project terminal row navigates into the project terminal", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);
		await user.click(screen.getByLabelText("More"));
		await user.click(screen.getByText("Project Terminal"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project-terminal", projectId: "p1" });
	});

	it("offers a Fullscreen toggle that requests element fullscreen (browser mode)", async () => {
		const user = userEvent.setup();
		const requestFullscreen = vi.fn(async () => {});
		Object.defineProperty(document.documentElement, "requestFullscreen", {
			configurable: true,
			value: requestFullscreen,
		});
		renderHeader({ screen: "dashboard" });
		await user.click(screen.getByLabelText("More"));
		await user.click(screen.getByText("Fullscreen"));
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("hides the Fullscreen row where the API is unavailable (iPhone Safari)", async () => {
		const user = userEvent.setup();
		Object.defineProperty(document.documentElement, "requestFullscreen", {
			configurable: true,
			value: undefined,
		});
		renderHeader({ screen: "dashboard" });
		await user.click(screen.getByLabelText("More"));
		expect(screen.queryByText("Fullscreen")).not.toBeInTheDocument();
	});

	it("keeps the stateful widgets (git pull, tmux) out of the inline header", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		// Folded into the kebab sheet — not sitting inline in the header row.
		expect(screen.queryByTestId("git-pull-button")).not.toBeInTheDocument();
		expect(screen.queryByTitle("tmux Sessions")).not.toBeInTheDocument();
	});

	it("surfaces the stateful widgets inside the bottom sheet", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(screen.getByLabelText("More"));
		// Git pull + tmux manager now live in the sheet's controls strip.
		expect(screen.getByTestId("git-pull-button")).toBeInTheDocument();
		expect(screen.getByLabelText("tmux Sessions")).toBeInTheDocument();
	});
});

describe("GlobalHeader — remote access button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("opens instantly on the first click via a non-blocking local QR fetch", async () => {
		const events: CustomEvent[] = [];
		const listener = (e: Event) => events.push(e as CustomEvent);
		window.addEventListener("rpc:showRemoteAccessQR", listener);
		try {
			renderHeader({ screen: "project", projectId: "p1" });
			await userEvent.click(
				screen.getByLabelText("Open on your phone — scan QR code for remote access"),
			);

			// The click must never trigger the blocking tunnel-start path
			// (default tunnel:true) that made the button need several clicks.
			expect(mockedApi.request.getRemoteAccessQR).toHaveBeenCalledWith({ tunnel: false });
			await vi.waitFor(() => expect(events).toHaveLength(1));
			expect(events[0].detail.autoStartTunnel).toBe(true);
		} finally {
			window.removeEventListener("rpc:showRemoteAccessQR", listener);
		}
	});
});
