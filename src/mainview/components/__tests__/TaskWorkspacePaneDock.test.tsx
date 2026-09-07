import { render, screen } from "@testing-library/react";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskWorkspacePane from "../TaskWorkspacePane";
import { getArtifactDock } from "../../utils/artifact-dock";

vi.mock("../../rpc", () => ({
	api: { request: { exitCopyModeAllPanes: vi.fn(() => Promise.resolve()) } },
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

afterEach(() => forceNarrow(false));

describe("TaskWorkspacePane artifact dock", () => {
	it("publishes no dock when no artifact wants one", () => {
		renderPane();
		expect(screen.queryByTestId("artifact-dock")).toBeNull();
		expect(screen.queryByRole("separator")).toBeNull();
		expect(getArtifactDock()).toBeNull();
	});

	it("renders the panel slot with its resize handle and publishes the dock", () => {
		renderPane({ dockArtifact: true });
		const slot = screen.getByTestId("artifact-dock");
		expect(getArtifactDock()).toBe(slot);
		const handle = screen.getByRole("separator");
		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		expect(handle).toHaveAttribute("tabindex", "0");
		// The terminal keeps its half of the split.
		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
	});

	it("takes the dock back on unmount, so the viewer falls back to the popup", () => {
		const { unmount } = renderPane({ dockArtifact: true });
		expect(getArtifactDock()).not.toBeNull();
		unmount();
		expect(getArtifactDock()).toBeNull();
	});

	it("refuses to dock on a narrow viewport — the popup is the compact presentation", () => {
		forceNarrow(true);
		renderPane({ dockArtifact: true });
		expect(screen.queryByTestId("artifact-dock")).toBeNull();
		expect(getArtifactDock()).toBeNull();
	});

	it("refuses to dock while the inline diff owns the surface", () => {
		renderPane({ dockArtifact: true, inlineDiffRequest: { mode: "branch", compareLabel: "origin/main" } });
		expect(screen.queryByTestId("artifact-dock")).toBeNull();
		expect(getArtifactDock()).toBeNull();
	});
});
