import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { getAppRoot } from "../../plugins/root";
import { syncHiddenControlsFromGlobalSettings } from "../../hidden-controls";
import type { Project, Task } from "../../../shared/types";
import { ACTIVE_STATUSES } from "../../../shared/types";
import type { TaskBranchStatusController } from "../../components/task-info-panel/useTaskBranchStatus";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../builtins";
import type { TaskSessionController } from "../useTaskSession";
import { TaskHeaderProvider, TaskHeaderRegionItems, type TaskHeaderLayout, type TaskHeaderSurface } from "../scope";

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../components/ScheduledMessagesChip", () => ({ default: () => <i data-testid="scheduled-chip" /> }));
vi.mock("../../components/task-info-panel/TaskPaneControls", () => ({
	default: ({ compact }: { compact?: boolean }) => <i data-testid="pane-controls" data-compact={String(!!compact)} />,
}));

const baseTask = { id: "t1", projectId: "p1", title: "Task", status: "in-progress", worktreePath: "/wt" } as Task;
const project = { id: "p1", name: "Project" } as Project;
const DESKTOP: TaskHeaderLayout = { compact: false, collapsed: true, tight: false, narrow: false };
const NARROW: TaskHeaderLayout = { ...DESKTOP, narrow: true };

function controller(): TaskSessionController {
	return {
		openSpawnAgent: vi.fn(),
		openBugHunters: vi.fn(),
		openScheduleMessage: vi.fn(),
		hibernate: vi.fn(async () => {}),
		hibernating: false,
		dialogs: null,
	};
}

function renderSession({ task = baseTask, layout = DESKTOP, surface = "bar" as TaskHeaderSurface, session = controller(), closeSheet = vi.fn() } = {}) {
	render(
		<I18nProvider>
			<TaskHeaderProvider
				value={{
					scope: { task, project, dispatch: vi.fn(), navigate: vi.fn() },
					layout,
					isTaskActive: ACTIVE_STATUSES.includes(task.status),
					git: {} as TaskBranchStatusController,
					session,
					closeSheet,
					variants: [],
				}}
			>
				<div data-testid="bar">
					<TaskHeaderRegionItems region="session" surface={surface} />
				</div>
			</TaskHeaderProvider>
		</I18nProvider>,
	);
	return session;
}

function labels(): string[] {
	return Array.from(screen.getByTestId("bar").querySelectorAll("[aria-label], [data-testid]"), (el) =>
		el.getAttribute("aria-label") ?? (el as HTMLElement).dataset.testid!);
}

function hide(ids: string[], simplifiedMode = false) {
	syncHiddenControlsFromGlobalSettings({ simplifiedMode, personalHiddenControls: ids as never });
}

beforeEach(() => {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
	hide([]);
});

describe("session items", () => {
	it("draws the desktop session bar in its fixed order", () => {
		renderSession();
		expect(labels()).toEqual([
			"Spawn a swarm of read-only bug hunters in the right pane",
			"Spawn another agent in a new pane",
			"Send later",
			"Hibernate",
			"scheduled-chip",
			"pane-controls",
		]);
	});

	it("leaves out a control the user hid, and keeps the rest", () => {
		hide(["bug-hunters", "hibernate", "tmux-pane-controls"]);
		renderSession();
		expect(screen.queryByTestId("task-hibernate-button")).toBeNull();
		expect(screen.queryByTestId("pane-controls")).toBeNull();
		expect(screen.getByTestId("scheduled-chip")).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(2);
	});

	it("shows only the pane controls once the task has no live session", () => {
		renderSession({ task: { ...baseTask, status: "completed" } as Task });
		expect(labels()).toEqual(["pane-controls"]);
	});

	it("folds the labels when compact and the pane controls when tight", () => {
		renderSession({ layout: { ...DESKTOP, compact: true, tight: true } });
		expect(screen.queryByText("Later")).toBeNull();
		expect(screen.getByTestId("pane-controls").dataset.compact).toBe("true");
	});

	it("runs the header's one controller from the bar", () => {
		const session = renderSession();
		for (const button of screen.getAllByRole("button")) fireEvent.click(button);
		expect(session.openBugHunters).toHaveBeenCalledOnce();
		expect(session.openSpawnAgent).toHaveBeenCalledOnce();
		expect(session.openScheduleMessage).toHaveBeenCalledOnce();
		expect(session.hibernate).toHaveBeenCalledOnce();
	});

	it("draws nothing on the narrow summary bar", () => {
		renderSession({ layout: NARROW });
		expect(screen.getByTestId("bar").textContent).toBe("");
		expect(labels()).toEqual([]);
	});

	it("gives the sheet Find bugs, + Agent and Hibernate rows, ignoring personal hiding", () => {
		hide(["bug-hunters", "spawn-agent", "hibernate"]);
		renderSession({ layout: NARROW, surface: "sheet" });
		expect(labels()).toEqual(["task-actions-bug-hunters", "task-actions-spawn-agent", "task-actions-hibernate"]);
	});

	it("drops the sheet rows under Simplified Mode", () => {
		hide([], true);
		renderSession({ layout: NARROW, surface: "sheet" });
		expect(labels()).toEqual([]);
	});

	it("closes the sheet before the hibernate flow asks", () => {
		const closeSheet = vi.fn();
		const session = renderSession({ layout: NARROW, surface: "sheet", closeSheet });
		fireEvent.click(screen.getByTestId("task-actions-hibernate"));
		expect(closeSheet).toHaveBeenCalledOnce();
		expect(session.hibernate).toHaveBeenCalledOnce();
	});

	it("isolates a crashing session item: the rest of the bar keeps rendering", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		function Crash(): never {
			throw new Error("boom");
		}
		await act(async () => {
			await getAppRoot().plugin({
				name: "crashing-session-item",
				inject: ["taskHeader"],
				apply(ctx: Context) {
					ctx.taskHeader.register({ id: "builtin:session.crash-test", region: "session", order: -1, component: Crash });
				},
			});
		});
		renderSession();
		expect(screen.getByTestId("task-hibernate-button")).toBeInTheDocument();
		expect(screen.getByTestId("pane-controls")).toBeInTheDocument();
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:session.crash-test crashed"))).toBe(true);
		error.mockRestore();
	});
});
