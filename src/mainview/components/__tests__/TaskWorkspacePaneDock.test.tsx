import { act, render, screen } from "@testing-library/react";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskWorkspacePane from "../TaskWorkspacePane";
import { isArtifactViewerShowing, showArtifactViewer } from "../../task-panels/artifact-panel";
import TaskPanelInstances from "../../task-panels/TaskPanelInstances";
import { installTaskPanelBuiltins } from "../../task-panels/__tests__/install-builtins";

vi.mock("../../rpc", () => ({
	api: { request: {
		exitCopyModeAllPanes: vi.fn(() => Promise.resolve()),
		readArtifactContent: vi.fn(() => Promise.resolve({ html: "<p>hi</p>", assets: [], downloadKind: "html" })),
		getTaskReview: vi.fn(() => Promise.resolve(null)),
	} },
	isElectrobun: false,
}));

vi.mock("../TaskTerminal", () => ({
	default: ({ taskId }: { taskId: string }) => <div data-testid="terminal-view">terminal:{taskId}</div>,
}));

vi.mock("../TaskDiffViewer", () => ({
	default: () => <div data-testid="diff-viewer" />,
}));

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
	title: "Task",
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

function renderPane(props: Partial<React.ComponentProps<typeof TaskWorkspacePane>> = {}) {
	return render(
		<I18nProvider>
			<TaskPanelInstances tasks={[task]} />
			<TaskWorkspacePane
				projectId="p1"
				taskId="t1"
				tasks={[task]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
				inlineDiffRequest={null}
				onCloseInlineDiff={vi.fn()}
				{...props}
			/>
		</I18nProvider>,
	);
}

/** Make `useNarrowViewport` report a phone-width viewport. */
function forceNarrow(narrow: boolean) {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes("max-width") ? narrow : query.includes("prefers-reduced-motion"),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}

beforeEach(installTaskPanelBuiltins);
afterEach(() => forceNarrow(false));

function openArtifact() {
	act(() => showArtifactViewer({
		taskId: "t1",
		projectId: "p1",
		index: 0,
		artifacts: [{ id: "a1", kind: "html", title: "Report", name: "a1.html", storedPath: "/wt/a1.html", originalPath: "/tmp/a1.html", bytes: 1, createdAt: 1, assets: [] }],
	}));
}

describe("TaskWorkspacePane artifact dock", () => {
	it("shows no dock when no artifact is open", () => {
		renderPane();
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(screen.queryByRole("separator")).toBeNull();
		expect(screen.queryByTestId("artifact-viewer")).toBeNull();
	});

	it("docks the open artifact beside the terminal, behind its resize handle", async () => {
		renderPane();
		openArtifact();
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "docked");
		expect(screen.getByTestId("task-dock")).toContainElement(viewer);
		const handle = screen.getByRole("separator");
		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		expect(handle).toHaveAttribute("tabindex", "0");
		// The terminal keeps its half of the split.
		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
	});

	it("waits offscreen, still mounted, when the pane goes away", async () => {
		const { rerender } = renderPane();
		openArtifact();
		await screen.findByTestId("artifact-viewer");
		rerender(<I18nProvider><TaskPanelInstances tasks={[task]} /></I18nProvider>);
		expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-presentation", "offscreen");
	});

	it("refuses to dock on a narrow viewport — the popup is the compact presentation", async () => {
		forceNarrow(true);
		renderPane();
		openArtifact();
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(viewer).toHaveAttribute("data-presentation", "popup");
	});

	it("waits offscreen in immersive fullscreen instead of covering the terminal", async () => {
		renderPane({ immersive: true });
		openArtifact();
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(viewer).toHaveAttribute("data-presentation", "offscreen");
		expect(isArtifactViewerShowing("t1")).toBe(false);
	});

	it("waits offscreen while the inline diff owns the surface", async () => {
		renderPane({ inlineDiffRequest: { mode: "branch", compareLabel: "origin/main" } });
		openArtifact();
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(viewer).toHaveAttribute("data-presentation", "offscreen");
	});
});
