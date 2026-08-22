/**
 * First run — what a brand-new install actually shows.
 *
 * Every assertion here was written against a real virgin `DEV3_HOME` driven in a
 * browser, so the cases are the ones that happen rather than the ones that read
 * plausibly. The load-bearing surprise: a new install is NEVER at zero projects
 * (the builtin Operations board is created on first boot), so the dashboard's
 * own zero-projects empty state can never render.
 */
import { render, screen } from "@testing-library/react";
import ActivityOverview from "../ActivityOverview";
import GlobalHeader from "../GlobalHeader";
import KanbanColumn from "../KanbanColumn";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	getRoundTripProbe: () => null,
	api: {
		request: {
			getAllProjectTasks: vi.fn().mockResolvedValue([]),
			getSpaces: vi.fn().mockResolvedValue({ version: 1, spaces: [], order: [] }),
			reorderSpaces: vi.fn(),
			reorderSpaceProjects: vi.fn(),
			openFolder: vi.fn(),
			moveTask: vi.fn(),
			deleteTask: vi.fn(),
			getSystemMemory: vi.fn().mockResolvedValue(null),
			getTasks: vi.fn().mockResolvedValue([]),
			saveLastRoute: vi.fn(),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 0 }),
			getPreventSleepState: vi.fn().mockResolvedValue({ enabled: false, available: false, forcedByRemote: false }),
			getAgentRateLimits: vi.fn().mockResolvedValue({ generatedAt: 0, snapshots: [] }),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("../../utils/moveTaskToStatus", () => ({ moveTaskToStatus: vi.fn(async () => true) }));
vi.mock("../../utils/confirmTaskCompletion", () => ({ confirmTaskCompletion: vi.fn().mockResolvedValue(true) }));
vi.mock("../../utils/ansi-to-html", () => ({ ansiToHtml: vi.fn((s: string) => s) }));
vi.mock("../TaskDetailModal", () => ({ default: () => null }));
vi.mock("../LabelPicker", () => ({ default: () => null }));

// happy-dom defaults to 1024px, which trips both the compact-column mode and the
// header's compact breakpoint and hides the chrome these tests assert on.
beforeEach(() => {
	Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1920 });
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: vi.fn((query: string) => {
			const m = query.match(/max-width:\s*(\d+)/);
			return {
				matches: m ? 1920 <= Number(m[1]) : false,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			};
		}),
	});
});

const gitProject: Project = {
	id: "p1",
	name: "hello-world",
	path: "/tmp/hello-world",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

/** What first boot actually writes into `virtual-projects.json`. */
const operations: Project = {
	...gitProject,
	id: "ops",
	name: "Operations",
	path: "",
	kind: "virtual",
	builtin: true,
};

function renderOverview(projects: Project[]) {
	return render(
		<I18nProvider>
			<ActivityOverview
				projects={projects}
				navigate={vi.fn()}
				dispatch={vi.fn()}
				bellCounts={new Map()}
				onRemoveProject={vi.fn()}
				onOpenAddProject={vi.fn()}
				onNewSpace={vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("Dashboard on a brand-new install", () => {
	it("explains dev-3.0 while the only project is the builtin Operations board", async () => {
		renderOverview([operations]);
		// The state this replaces: one project on the board, so `noProjects` is dead
		// code and the screen used to open on an empty Velocity Cockpit link.
		expect(await screen.findByTestId("dashboard-first-run")).toBeTruthy();
		expect(screen.queryByText("Productivity stats")).toBeNull();
	});

	it("keeps the centre of the screen for the dashboard, not for teaching", async () => {
		// Arseny's call: the plate explaining the `?` moved to a callout beside the
		// button itself, so this strip stays a heading plus one sentence.
		renderOverview([operations]);
		const panel = await screen.findByTestId("dashboard-first-run");
		expect(panel.textContent).not.toContain("Every screen can explain itself");
		expect(screen.queryByTestId("dashboard-first-run-help")).toBeNull();
	});

	it("documents Spaces on the New space button, where a first-timer can reach it", async () => {
		// The rail owns this topic and the rail does not exist until a space does.
		renderOverview([operations, gitProject]);
		const btn = await screen.findByTestId("dashboard-new-space");
		expect(btn.getAttribute("data-help-id")).toBe("dashboard.spaces");
	});

	it("hands the slot back to the stats card once a repository exists", async () => {
		renderOverview([operations, gitProject]);
		expect(await screen.findByText("Productivity stats")).toBeTruthy();
		expect(screen.queryByTestId("dashboard-first-run")).toBeNull();
	});

	it("puts Add project in help mode — the first screen's own primary action", async () => {
		renderOverview([operations, gitProject]);
		const add = (await screen.findByText("Add project")).closest("button");
		expect(add?.getAttribute("data-help-id")).toBe("dashboard.add-project");
	});
});

function renderColumn(overrides: { status?: "todo" | "in-progress"; boardEmpty?: boolean } = {}) {
	const status = overrides.status ?? "todo";
	return render(
		<I18nProvider>
			<KanbanColumn
				status={status}
				label={status === "todo" ? "To Do" : "Agent is Working"}
				tasks={[]}
				project={gitProject}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				onAddTask={vi.fn()}
				agents={[]}
				onLaunchVariants={vi.fn()}
				onAddAttempts={vi.fn()}
				onTaskDrop={vi.fn()}
				dragFromStatus={null}
				dragFromCustomColumnId={null}
				onDragStart={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				taskDevServers={new Map()}
				movingTaskIds={new Set()}
				onSetMoving={vi.fn()}
				siblingMap={new Map()}
				boardEmpty={overrides.boardEmpty}
			/>
		</I18nProvider>,
	);
}

describe("Empty board columns", () => {
	it("never points a column with no New Task button at one", () => {
		// The bug this guards: `kanban.noTasksHint` rendered in EVERY empty column
		// while the button exists only in To Do, so four columns on a virgin board
		// described a control that was not there.
		renderColumn({ status: "in-progress" });
		expect(screen.getByText(/Tasks arrive here on their own/)).toBeTruthy();
		expect(screen.queryByText(/use the button below/)).toBeNull();
	});

	it("keeps the button hint in To Do, which does have the button", () => {
		renderColumn({ status: "todo" });
		expect(screen.getByText(/use the button below/)).toBeTruthy();
	});

	it("explains the first task when the whole board is empty", () => {
		renderColumn({ status: "todo", boardEmpty: true });
		expect(screen.getByText(/Your first task goes here/)).toBeTruthy();
		// The trap it defuses: the New Task modal's primary blue button is `Save`,
		// which does not launch anything.
		expect(screen.getByText(/Save & Start/)).toBeTruthy();
	});
});

function renderHeader(route: Route, helpDiscovered?: boolean) {
	return render(
		<I18nProvider>
			<GlobalHeader
				route={route}
				projects={[gitProject]}
				tasks={[]}
				navigate={vi.fn()}
				goBack={vi.fn()}
				goForward={vi.fn()}
				canGoBack={false}
				canGoForward={false}
				remoteAccessActive={false}
				helpDiscovered={helpDiscovered}
			/>
		</I18nProvider>,
	);
}

describe("The ? button rests highlighted until help mode is opened once", () => {
	it.each<Route>([
		{ screen: "dashboard" },
		{ screen: "project", projectId: "p1" },
		{ screen: "task", projectId: "p1", taskId: "t1" },
		{ screen: "project-settings", projectId: "p1" },
	])("highlights it on $screen", (route) => {
		renderHeader(route);
		expect(screen.getByTestId("header-help-mode").getAttribute("data-help-attractor")).toBe("on");
	});

	it("stops highlighting for good once help mode has been opened", () => {
		renderHeader({ screen: "dashboard" }, true);
		expect(screen.getByTestId("header-help-mode").getAttribute("data-help-attractor")).toBeNull();
	});

	it("stays quiet on screens nobody lands on first", () => {
		renderHeader({ screen: "changelog" });
		expect(screen.getByTestId("header-help-mode").getAttribute("data-help-attractor")).toBeNull();
		expect(screen.queryByTestId("help-attractor-callout")).toBeNull();
	});

	it("puts the explanation in a callout beside the button, not mid-screen", () => {
		renderHeader({ screen: "dashboard" });
		const callout = screen.getByTestId("help-attractor-callout");
		expect(callout.textContent).toContain("Start here");
		expect(callout.textContent).toContain("every screen");
	});

	it("treats closing the callout as discovery", () => {
		const seen: Event[] = [];
		window.addEventListener("help:dismiss-attractor", (e) => seen.push(e));
		renderHeader({ screen: "dashboard" });
		screen.getByTestId("help-attractor-dismiss").click();
		expect(seen.length).toBe(1);
	});

	it("shows no callout once help mode has been opened", () => {
		renderHeader({ screen: "dashboard" }, true);
		expect(screen.queryByTestId("help-attractor-callout")).toBeNull();
	});
});
