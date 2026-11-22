import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import type { Project, Task } from "../../../shared/types";
import { ACTIVE_STATUSES } from "../../../shared/types";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../builtins";
import type { TaskBranchStatusController } from "../../components/task-info-panel/useTaskBranchStatus";
import type { TaskSessionController } from "../useTaskSession";
import { TaskHeaderProvider, TaskHeaderRegionItems, type TaskHeaderLayout, type TaskHeaderSurface } from "../scope";

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../components/task-info-panel/TaskOpenIn", () => ({ default: ({ compact }: { compact?: boolean }) => <i data-testid="open-in" data-compact={String(!!compact)} /> }));
vi.mock("../../components/task-info-panel/TaskFileExplorerToggle", () => ({ default: () => <i data-testid="file-explorer" /> }));
vi.mock("../../components/task-info-panel/TaskScripts", () => ({ default: () => <i data-testid="scripts" /> }));
vi.mock("../../components/task-info-panel/TaskDevServer", () => ({ default: () => <i data-testid="dev-server" /> }));
vi.mock("../../components/task-info-panel/TaskExposedPorts", () => ({
	default: ({ rowClassName }: { rowClassName?: string }) => <i data-testid={rowClassName ? "ports-row" : "ports"} />,
}));
vi.mock("../../components/task-info-panel/TaskSharedImages", () => ({ default: () => <i data-testid="images" /> }));
vi.mock("../../components/task-info-panel/TaskArtifacts", () => ({ default: () => <i data-testid="artifacts" /> }));

const baseTask = { id: "t1", projectId: "p1", title: "Task", status: "in-progress", worktreePath: "/wt" } as Task;
const project = { id: "p1", name: "Project" } as Project;
const DESKTOP: TaskHeaderLayout = { compact: false, collapsed: true, tight: false, narrow: false };
const NARROW: TaskHeaderLayout = { ...DESKTOP, narrow: true };
const git = {} as TaskBranchStatusController;

function renderRuntime({ task = baseTask, proj = project, layout = DESKTOP, surface = "bar" as TaskHeaderSurface, closeSheet = vi.fn() } = {}) {
	return render(
		<I18nProvider>
			<TaskHeaderProvider value={{ scope: { task, project: proj, dispatch: vi.fn(), navigate: vi.fn() }, layout, isTaskActive: ACTIVE_STATUSES.includes(task.status), resolvedProject: proj, git, session: {} as TaskSessionController, closeSheet, variants: [] }}>
				<div data-testid="bar">
					<TaskHeaderRegionItems region="runtime" surface={surface} />
				</div>
			</TaskHeaderProvider>
		</I18nProvider>,
	);
}

function order(): string[] {
	return Array.from(screen.getByTestId("bar").querySelectorAll("[data-testid]"), (el) => (el as HTMLElement).dataset.testid!);
}

beforeEach(() => {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
});

describe("runtime items", () => {
	it("draws the desktop runtime bar in its fixed order", () => {
		renderRuntime();
		expect(order()).toEqual(["open-in", "file-explorer", "scripts", "dev-server", "ports", "images", "artifacts"]);
	});

	it("shows the file explorer toggle only while collapsed, and passes the tight fold", () => {
		renderRuntime({ layout: { ...DESKTOP, collapsed: false, tight: true } });
		expect(screen.queryByTestId("file-explorer")).toBeNull();
		expect(screen.getByTestId("open-in").dataset.compact).toBe("true");
	});

	it("leaves scripts and the dev server out of a virtual project", () => {
		renderRuntime({ proj: { ...project, kind: "virtual" } as Project });
		expect(order()).toEqual(["open-in", "file-explorer", "ports", "images", "artifacts"]);
	});

	it("draws nothing on the narrow summary bar", () => {
		renderRuntime({ layout: NARROW });
		expect(order()).toEqual([]);
	});

	it("gives the sheet a ports row and only the media rows that have something", () => {
		renderRuntime({ layout: NARROW, surface: "sheet" });
		expect(order()).toEqual(["ports-row"]);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("closes the sheet before opening the artifact viewer", () => {
		const closeSheet = vi.fn();
		const opened = vi.fn();
		window.addEventListener("dev3:openArtifactViewer", opened);
		const task = { ...baseTask, sharedArtifacts: [{ id: "a1" }] } as unknown as Task;
		renderRuntime({ task, layout: NARROW, surface: "sheet", closeSheet });
		fireEvent.click(screen.getByRole("button", { name: /artifacts/i }));
		expect(closeSheet).toHaveBeenCalledTimes(1);
		expect(opened).toHaveBeenCalledTimes(1);
		window.removeEventListener("dev3:openArtifactViewer", opened);
	});

	it("labels the media row Images until a clip arrives", () => {
		const image = { id: "i1", mime: "image/png", createdAt: 1 };
		renderRuntime({ task: { ...baseTask, sharedImages: [image] } as unknown as Task, layout: NARROW, surface: "sheet" });
		expect(screen.getByRole("button", { name: /images/i })).toHaveTextContent("1");
	});

	it("closes the sheet and opens the viewer on the whole media history, labelled Media with a clip", () => {
		const closeSheet = vi.fn();
		const opened = vi.fn();
		window.addEventListener("dev3:openImageViewer", opened);
		const image = { id: "i1", mime: "image/png", createdAt: 2 };
		const clip = { id: "v1", mime: "video/mp4", createdAt: 1 };
		const task = { ...baseTask, sharedImages: [image], sharedVideos: [clip] } as unknown as Task;
		renderRuntime({ task, layout: NARROW, surface: "sheet", closeSheet });
		const row = screen.getByRole("button", { name: /media/i });
		expect(row).toHaveTextContent("2");
		fireEvent.click(row);
		expect(closeSheet).toHaveBeenCalledTimes(1);
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "t1", projectId: "p1", images: [clip, image] });
		window.removeEventListener("dev3:openImageViewer", opened);
	});
});
