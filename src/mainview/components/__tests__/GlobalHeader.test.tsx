import { render, screen, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalHeader from "../GlobalHeader";
import { I18nProvider } from "../../i18n";
import type { Project, Task, UpdateChangelog } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	// Browser mode: the fullscreen toggle row is visible in the action sheet.
	isElectrobun: false,
	// No round-trip probe: the connection-quality readout starts and stays silent,
	// which is what this suite wants — it is not the widget's test.
	getRoundTripProbe: () => null,
	api: {
		request: {
			getSystemMemory: vi.fn().mockResolvedValue(null),
			getTasks: vi.fn(),
			applyUpdate: vi.fn(),
			// The update plaque asks what a restart would interrupt (and whether it keeps
			// the remote link) as soon as an update is offered.
			getUpdateRestartContext: vi.fn().mockResolvedValue({ headless: false, tasksInProgress: 0 }),
			saveLastRoute: vi.fn(),
			renameTask: vi.fn(),
			// `behindOrigin` > 0 keeps the pull button rendered — it hides when there is nothing to pull.
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 2 }),
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
			getSpaces: vi.fn().mockResolvedValue({ version: 1, spaces: [], order: [] }),
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

/** The one breadcrumb-task fixture: inline rename and the backend marker share it. */
function makeBreadcrumbTask(overrides?: Partial<Task>): Task {
	return {
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
		...overrides,
	};
}

function renderHeader(
	route: Route,
	projects: Project[] = [project1, project2],
	navigate?: (route: Route) => void,
	tasks: Task[] = [],
	extra?: {
		updateVersion?: string | null;
		updateAnnouncement?: number;
		updateChangelog?: UpdateChangelog | null;
		updateDownloadStatus?: string | null;
		remoteAccessActive?: boolean;
		goBack?: () => void;
		goForward?: () => void;
		canGoBack?: boolean;
		canGoForward?: boolean;
	},
) {
	return render(headerElement(route, projects, navigate, tasks, extra));
}

function headerElement(
	route: Route,
	projects: Project[] = [project1, project2],
	navigate?: (route: Route) => void,
	tasks: Task[] = [],
	extra?: Parameters<typeof renderHeader>[4],
) {
	return (
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
				updateAnnouncement={extra?.updateAnnouncement}
				updateChangelog={extra?.updateChangelog}
				updateDownloadStatus={extra?.updateDownloadStatus}
				remoteAccessActive={extra?.remoteAccessActive ?? false}
			/>
		</I18nProvider>
	);
}

function getChevronButton() {
	return screen.getByLabelText("Switch project");
}

describe("GlobalHeader — project switcher dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
		mockedApi.request.getSpaces.mockResolvedValue({ version: 1, spaces: [], order: [] });
	});

	it("shows chevron button next to project name when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		const chevron = getChevronButton();
		expect(chevron).toBeInTheDocument();
		// Project name text is rendered separately from the chevron
		expect(screen.getByText("Project Alpha")).toBeInTheDocument();
	});

	it("declares the chevron as a menu trigger and reflects the open state", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		const chevron = getChevronButton();
		expect(chevron).toHaveAttribute("aria-haspopup", "menu");
		expect(chevron).toHaveAttribute("aria-expanded", "false");
		await user.click(chevron);
		expect(chevron).toHaveAttribute("aria-expanded", "true");
	});

	it("keeps the name and the chevron inside one bordered segmented control", () => {
		renderHeader({ screen: "project", projectId: "p1", activeTaskId: "t1" }, [project1, project2], vi.fn(), [
			{ id: "t1", seq: 1, title: "Task 1", status: "in-progress" } as Task,
		]);
		const shell = getChevronButton().parentElement!;
		expect(shell).toHaveClass("border-edge");
		// Both halves live in that shell — the chevron is no longer a loose glyph.
		expect(within(shell).getByRole("button", { name: "Project Alpha" })).toBeInTheDocument();
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

	it("styles the clickable project name as an accent link", () => {
		const navigate = vi.fn();
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1, project2],
			navigate,
			[{ id: "t1", seq: 1, title: "Task 1", status: "in-progress" } as Task],
		);

		const projectName = screen.getByRole("button", { name: "Project Alpha" });
		expect(projectName).toHaveClass("text-accent", "hover:text-accent-emphasis");
		expect(projectName).not.toHaveClass("text-fg-3");
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

	describe("space grouping", () => {
		const project4: Project = { ...project2, id: "p4", name: "Project Delta" };

		function withSpaces() {
			// Board order puts sp_other first; the current project (p1) is in sp_dev,
			// so sp_dev must still be rendered first.
			mockedApi.request.getSpaces.mockResolvedValue({
				version: 1,
				spaces: [
					{ id: "sp_dev", name: "Dev Space", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 },
					{ id: "sp_other", name: "Other Space", parentId: null, projectIds: ["p2"], createdAt: 2 },
				],
				order: ["sp_other", "sp_dev"],
			});
		}

		async function openSwitcher() {
			const user = userEvent.setup();
			renderHeader({ screen: "project", projectId: "p1" }, [project1, project2, project4]);
			await user.click(getChevronButton());
			return await screen.findByRole("menu");
		}

		it("hoists the current project's space above the other groups, Home last", async () => {
			withSpaces();
			const menu = await openSwitcher();
			await within(menu).findByText("Dev Space");
			const headers = within(menu)
				.getAllByText(/Dev Space|Other Space|Home/)
				.map((el) => el.textContent);
			expect(headers).toEqual(["Dev Space", "Other Space", "Home"]);
		});

		it("lists a project under every space it belongs to, plus once under Home", async () => {
			withSpaces();
			const menu = await openSwitcher();
			await within(menu).findByText("Dev Space");
			// Beta is in both spaces → two rows; Delta has no space → the Home group.
			expect(within(menu).getAllByText("Project Beta")).toHaveLength(2);
			expect(within(menu).getAllByText("Project Delta")).toHaveLength(1);
		});

		it("keeps the ⌘N badge on board order, not on the regrouped row order", async () => {
			withSpaces();
			const menu = await openSwitcher();
			await within(menu).findByText("Dev Space");
			const rows = within(menu).getAllByRole("button");
			const badgeOf = (name: string) =>
				rows.find((r) => r.textContent?.includes(name))?.querySelector("kbd")?.textContent;
			// p1 is board index 0 → ⌘1, even though it now sits under a hoisted space.
			expect(badgeOf("Project Alpha")).toBe("⌘1");
			expect(badgeOf("Project Beta")).toBe("⌘2");
			expect(badgeOf("Project Delta")).toBe("⌘3");
		});

		it("stays flat when no space holds a visible project", async () => {
			const menu = await openSwitcher();
			expect(within(menu).queryByText("Home")).not.toBeInTheDocument();
			expect(within(menu).getAllByRole("button")).toHaveLength(3);
		});
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

		// The auto-shown toast renders the same list; dismiss it so the queries
		// below target the dropdown only.
		await user.click(screen.getByText("Postpone"));
		await user.click(screen.getByRole("button", { name: /Version 1\.38\.0 is ready/i }));

		expect(screen.getByText("What's new in v1.38.0")).toBeInTheDocument();
		expect(screen.getByText("Terminal scrollback search")).toBeInTheDocument();
		expect(screen.getByText("PR review threads in diff")).toBeInTheDocument();
		// 5 total features, 2 shown → "+3 more features · 4 fixes"
		expect(screen.getByText("+3 more features · 4 fixes")).toBeInTheDocument();
	});

	it("renders the what's-new changelog section in the auto-shown update toast", () => {
		const changelog: UpdateChangelog = {
			features: ["Terminal scrollback search", "PR review threads in diff"],
			featureCount: 5,
			fixCount: 4,
		};
		renderHeader({ screen: "dashboard" }, [project1, project2], vi.fn(), [], {
			updateVersion: "1.38.0",
			updateChangelog: changelog,
		});

		// Toast auto-shows on update-ready (no dropdown click); it must surface the
		// same preview as the dropdown — regression: the toast previously omitted it.
		expect(screen.getByText("What's new in v1.38.0")).toBeInTheDocument();
		expect(screen.getByText("Terminal scrollback search")).toBeInTheDocument();
		expect(screen.getByText("+3 more features · 4 fixes")).toBeInTheDocument();
	});

	it("navigates to the changelog screen from 'See all changes'", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "dashboard" }, [project1, project2], navigate, [], {
			updateVersion: "1.38.0",
			updateChangelog: { features: ["A feature"], featureCount: 1, fixCount: 0 },
		});

		// Dismiss the auto-shown toast first so "See all changes" is unambiguous.
		await user.click(screen.getByText("Postpone"));
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

	it("shows pencil icon on hover for task segment in full-page view", () => {
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[makeBreadcrumbTask()],
		);
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
		expect(screen.getByTitle("Edit title")).toBeInTheDocument();
	});

	it("shows branch, seq and labels on the title hover card", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[{ ...project1, labels: [{ id: "lbl1", name: "Bug", color: "#ef4444" }] }],
			vi.fn(),
			[makeBreadcrumbTask({ labelIds: ["lbl1"] })],
		);
		expect(screen.queryByTestId("task-title-hover-card")).not.toBeInTheDocument();

		await user.hover(screen.getByText("My Task Title"));

		const card = screen.getByTestId("task-title-hover-card");
		expect(within(card).getByText("feat/test")).toBeInTheDocument();
		expect(within(card).getByText("#42")).toBeInTheDocument();
		expect(within(card).getByText("Bug")).toBeInTheDocument();
	});

	it("shows pencil icon for task segment in split view", () => {
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1],
			vi.fn(),
			[makeBreadcrumbTask()],
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
			[makeBreadcrumbTask()],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();
	});

	it("saves new title on Enter", async () => {
		const user = userEvent.setup();
		const updatedTask = makeBreadcrumbTask({ customTitle: "New Name" });
		mockedApi.request.renameTask.mockResolvedValue(updatedTask);

		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[makeBreadcrumbTask()],
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
			[makeBreadcrumbTask()],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();

		await user.click(screen.getByTestId("rename-cancel"));
		expect(screen.queryByDisplayValue("My Task Title")).not.toBeInTheDocument();
		// Scoped to the breadcrumb: pointing at the title also opens the hover
		// card, which repeats the title in full.
		expect(within(screen.getByRole("navigation")).getByText("My Task Title")).toBeInTheDocument();
	});

	it("does not save when title is unchanged", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[makeBreadcrumbTask()],
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
		// Auto-restart now requires a KNOWN non-headless context, so each test states
		// it — `clearAllMocks` clears calls but not an implementation a sibling set.
		mockedApi.request.getUpdateRestartContext.mockResolvedValue({ headless: false, tasksInProgress: 0 });
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

	it("re-opens the postponed toast when the same version is announced again (issue #1072)", () => {
		const view = render(
			headerElement({ screen: "dashboard" }, [project1], vi.fn(), [], {
				updateVersion: "1.2.3",
				updateAnnouncement: 1,
			}),
		);
		act(() => { fireEvent.click(screen.getByText("Postpone")); });
		expect(screen.queryByText(/Restart to Update \(\d+s\)/)).not.toBeInTheDocument();

		view.rerender(
			headerElement({ screen: "dashboard" }, [project1], vi.fn(), [], {
				updateVersion: "1.2.3",
				updateAnnouncement: 2,
			}),
		);

		expect(screen.getByText(/Restart to Update \(300s\)/)).toBeInTheDocument();
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

	// The auto-restart gate must FAIL CLOSED. It reads the restart context over RPC;
	// while that is unknown — pending, or failed — the box may be a headless
	// `dev3 remote` server, where an unattended restart from a phone tab is exactly
	// what the quiet-window policy refuses. Not knowing means not restarting.
	it("does NOT auto-restart on a headless box", async () => {
		mockedApi.request.getUpdateRestartContext.mockResolvedValue({ headless: true, tasksInProgress: 0 });
		renderHeader({ screen: "dashboard" }, [project1], vi.fn(), [], { updateVersion: "1.2.3" });

		act(() => { vi.advanceTimersByTime(300_000); });
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(mockedApi.request.applyUpdate).not.toHaveBeenCalled();
	});

	it("does NOT auto-restart when the restart context could not be read", async () => {
		mockedApi.request.getUpdateRestartContext.mockRejectedValue(new Error("no answer"));
		renderHeader({ screen: "dashboard" }, [project1], vi.fn(), [], { updateVersion: "1.2.3" });

		act(() => { vi.advanceTimersByTime(300_000); });
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(mockedApi.request.applyUpdate).not.toHaveBeenCalled();
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

		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("Update not ready to apply"),
			// The toast names where it came from, so it is not a bare sentence.
			{ source: "update" },
		);
		// The UI must not stay stuck on "Restarting..."
		expect(screen.queryByText("Restarting...")).not.toBeInTheDocument();
	});

	// An interactive `dev3 remote --no-detach` has no supervisor, so the server
	// installs the update and stays alive. The handler resolved without a value, so
	// the button spun "Restarting..." forever and the sentence explaining the manual
	// restart went nowhere.
	it("stops spinning and says so when the update installed but nothing restarts", async () => {
		mockedApi.request.applyUpdate.mockResolvedValue({
			restarting: false,
			message: "Installed 1.46.0. This server runs in the foreground, so restart it yourself.",
		} as never);
		renderHeader({ screen: "dashboard" }, [project1], vi.fn(), [], { updateVersion: "1.2.3" });

		act(() => { fireEvent.click(screen.getByText(/Restart to Update \(\d+s\)/)); });
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(toast.info).toHaveBeenCalledWith(
			expect.stringContaining("restart it yourself"),
			{ source: "update" },
		);
		expect(screen.queryByText("Restarting...")).not.toBeInTheDocument();
	});

	it("saves current route via RPC before applying update", async () => {
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { vi.advanceTimersByTime(300_000); });
		// The gate waits for the restart context, so the auto-restart is one microtask
		// behind the countdown now.
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

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

	it("keeps quick shell out of the bar and inside the kebab menu, icon included", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.queryByLabelText("Quick Shell — new scratch in Operations (⌘⇧`)")).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("More"));
		const quickShellButton = screen.getByLabelText("Quick Shell — new scratch in Operations (⌘⇧`)");
		expect(quickShellButton).toHaveAttribute("role", "menuitem");
		expect(quickShellButton.querySelector("svg")).toBeTruthy();
		expect(quickShellButton.className).toContain("header-anim");
	});

	it("fires the quick-shell event from the menu row and closes the menu", async () => {
		const user = userEvent.setup();
		const handler = vi.fn();
		window.addEventListener("menu:open-quick-shell", handler);
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(screen.getByLabelText("More"));
		await user.click(screen.getByLabelText("Quick Shell — new scratch in Operations (⌘⇧`)"));

		expect(handler).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		window.removeEventListener("menu:open-quick-shell", handler);
	});

	it("keeps the tmux session list in the kebab menu too", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.queryByLabelText("tmux Sessions")).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("More"));
		expect(screen.getByLabelText("tmux Sessions")).toHaveAttribute("role", "menuitem");
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
		// The QR icon lives in the DESKTOP window. Seen from the far end of a remote
		// session it would offer a code for the connection already in use, so that
		// slot carries the connection-quality readout there instead.
		(window as any).__electrobunWebviewId = 1;
	});
	afterEach(() => {
		delete (window as any).__electrobunWebviewId;
	});

	it("hands the slot to the connection-quality readout in a remote tab", () => {
		delete (window as any).__electrobunWebviewId;
		renderHeader({ screen: "dashboard" });

		expect(
			screen.queryByLabelText("Open on your phone — scan QR code for remote access"),
		).not.toBeInTheDocument();
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

	it("keeps prevent-sleep out of the roomy header bar and inside the kebab menu", async () => {
		mockMatchMedia(false);
		mockedApi.request.getPreventSleepState.mockResolvedValue({
			enabled: true,
			available: true,
			forcedByRemote: false,
		});
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		// Nobody switches it off, so the bar itself no longer carries it.
		await act(async () => {});
		expect(screen.queryByLabelText("No Sleep")).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("More"));
		const toggle = await screen.findByLabelText("No Sleep");
		// Inside the menu, not merely somewhere on screen — that is the whole point.
		expect(toggle.closest("[role=menu]")).not.toBeNull();
		expect(toggle).toHaveAttribute("role", "menuitem");
	});

	it("stays open while a menu row's flyout is clicked — it is portaled, not outside", async () => {
		mockMatchMedia(false);
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });
		await act(async () => {});

		await user.click(screen.getByLabelText("More"));
		expect(screen.getByText("Change Log")).toBeInTheDocument();

		// The memory / tmux detail panels render into <body>, so by DOM they are
		// "outside" the menu. Clicking one must not dismiss the menu underneath.
		const flyout = document.createElement("div");
		flyout.setAttribute("data-header-flyout", "true");
		const inner = document.createElement("button");
		flyout.appendChild(inner);
		document.body.appendChild(flyout);
		await act(async () => {
			fireEvent.mouseDown(inner);
		});
		expect(screen.getByText("Change Log")).toBeInTheDocument();

		// An ordinary outside click still closes it.
		await act(async () => {
			fireEvent.mouseDown(document.body);
		});
		expect(screen.queryByText("Change Log")).not.toBeInTheDocument();
		flyout.remove();
	});

	it("opens the utilities cluster — nothing sits left of the kebab", async () => {
		renderHeader({ screen: "project", projectId: "p1" });
		await act(async () => {});

		const more = screen.getByLabelText("More");
		const cluster = document.querySelector('[data-help-id="header.utilities"]')!;
		expect(cluster).toContainElement(more);
		// Every other control in the cluster must follow it in document order.
		const others = [...cluster.querySelectorAll("button")].filter((b) => b !== more && !more.contains(b));
		expect(others.length).toBeGreaterThan(0);
		for (const other of others) {
			expect(more.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		}
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

	it("shows the Pull button for a git project with commits waiting upstream", async () => {
		renderHeader({ screen: "project", projectId: "p1" });
		expect(await screen.findByText("Pull")).toBeInTheDocument();
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
		expect(rows[0].textContent).toContain("System");
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

	it("folds the memory readout off the header and into the sheet", async () => {
		const user = userEvent.setup();
		mockedApi.request.getSystemMemory.mockResolvedValue({
			headroom: 12 * 1024 ** 3,
			used: 52 * 1024 ** 3,
			total: 64 * 1024 ** 3,
			cached: 0,
			pressure: "normal",
			pressureEstimated: false,
			swapUsed: 0,
			swapTotal: 0,
			swapping: false,
			topConsumers: [],
			appRss: 0,
			activeTaskCount: 0,
			tasksRssApprox: 0,
			topTasks: [],
			medianTaskRss: null,
		});
		renderHeader({ screen: "project", projectId: "p1" });
		// Nothing but the breadcrumb and the kebab survives in a phone header.
		await act(async () => {});
		expect(screen.queryByTestId("memory-headroom-indicator")).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("More"));
		expect(screen.getByTestId("memory-headroom-indicator")).toBeInTheDocument();
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
		expect(await screen.findByTestId("git-pull-button")).toBeInTheDocument();
		expect(screen.getByLabelText("tmux Sessions")).toBeInTheDocument();
	});
});

describe("GlobalHeader — remote access button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("opens instantly on the first click via a non-blocking local QR fetch", async () => {
		// Desktop: the QR button only exists there (see the remote-access suite).
		(window as any).__electrobunWebviewId = 1;
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
			delete (window as any).__electrobunWebviewId;
		}
	});
});

describe("GlobalHeader — native terminal backend mark", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("marks a native-backed task in the breadcrumb", () => {
		renderHeader({ screen: "task", projectId: "p1", taskId: "t1" }, [project1], vi.fn(), [
			makeBreadcrumbTask({ terminalBackend: "native" }),
		]);

		expect(screen.getByTestId("breadcrumb-native-backend")).toHaveAttribute(
			"aria-label",
			"Native terminal backend",
		);
	});

	it("stays quiet for an explicit tmux task and for a legacy unmarked one", () => {
		const { unmount } = renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[makeBreadcrumbTask({ terminalBackend: "tmux" })],
		);
		expect(screen.queryByTestId("breadcrumb-native-backend")).toBeNull();
		unmount();

		renderHeader({ screen: "task", projectId: "p1", taskId: "t1" }, [project1], vi.fn(), [
			makeBreadcrumbTask(),
		]);
		expect(screen.queryByTestId("breadcrumb-native-backend")).toBeNull();
	});
});
