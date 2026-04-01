import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Task, TaskDiffResponse } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskDiffViewer from "../TaskDiffViewer";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskDiff: vi.fn(),
		},
	},
}));

vi.mock("@git-diff-view/react", () => ({
	DiffView: ({ diffViewMode, diffViewTheme }: { diffViewMode: number; diffViewTheme: "dark" | "light" }) => (
		<div data-testid="mock-diff">mode:{diffViewMode} theme:{diffViewTheme}</div>
	),
	DiffModeEnum: {
		Split: 3,
		Unified: 4,
	},
	DiffFile: class {
		initTheme() {}
		initRaw() {}
		buildSplitDiffLines() {}
		buildUnifiedDiffLines() {}
	},
}));

vi.mock("@git-diff-view/file", () => ({
	generateDiffFile: () => ({
		initTheme() {},
		initRaw() {},
		buildSplitDiffLines() {},
		buildUnifiedDiffLines() {},
	}),
}));

import { api } from "../../rpc";

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

const diffPayload: TaskDiffResponse = {
	mode: "branch",
	compareRef: "origin/main",
	compareLabel: "origin/main",
	fallbackReason: null,
	summary: {
		files: 3,
		insertions: 5,
		deletions: 1,
	},
	files: [
		{
			id: "src/app.ts",
			status: "modified",
			displayPath: "src/app.ts",
			oldPath: "src/app.ts",
			newPath: "src/app.ts",
			oldContent: "const a = 1;\n",
			newContent: "const a = 2;\nconst b = 3;\n",
			hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n"],
		},
		{
			id: "src/utils/format.ts",
			status: "added",
			displayPath: "src/utils/format.ts",
			oldPath: null,
			newPath: "src/utils/format.ts",
			oldContent: "",
			newContent: "export const ok = true;\n",
			hunks: ["diff --git a/src/utils/format.ts b/src/utils/format.ts\n@@ -0,0 +1 @@\n+export const ok = true;\n"],
		},
		{
			id: "docs/readme.md",
			status: "modified",
			displayPath: "docs/readme.md",
			oldPath: "docs/readme.md",
			newPath: "docs/readme.md",
			oldContent: "old\n",
			newContent: "new\n",
			hunks: ["diff --git a/docs/readme.md b/docs/readme.md\n@@ -1 +1 @@\n-old\n+new\n"],
		},
	],
	skippedBinaryFiles: [],
	skippedLargeFiles: [],
};

describe("TaskDiffViewer", () => {
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			...diffPayload,
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
		}));
		localStorage.clear();
		document.documentElement.dataset.theme = "dark";
		scrollIntoViewMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoViewMock,
		});
	});

	it("defaults to split mode, opens files by default, and lets a file be marked as read", async () => {
		const user = userEvent.setup();

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")).toHaveLength(2);
		});

		expect(screen.getAllByTestId("mock-diff")[0]).toHaveTextContent("mode:3 theme:dark");
		const firstFileHeader = screen.getByRole("button", { name: /collapse src\/app\.ts/i }).closest("div");
		expect(firstFileHeader).toHaveClass("sticky");
		expect(firstFileHeader).not.toBeNull();
		expect(within(firstFileHeader as HTMLDivElement).getByText("+2")).toBeInTheDocument();
		expect(within(firstFileHeader as HTMLDivElement).getByText("−1")).toBeInTheDocument();

		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));

		expect(screen.getAllByText("src/app.ts")[0]).toHaveClass("line-through");
		expect(within(screen.getByRole("button", { name: /open diff file src\/app\.ts/i })).getByText("app.ts")).toHaveClass("line-through");
		expect(screen.getAllByTestId("mock-diff")).toHaveLength(1);

		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));
		expect(await screen.findAllByTestId("mock-diff")).toHaveLength(2);
	});

	it("switches diff source modes inside the viewer", async () => {
		const user = userEvent.setup();

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");
		await user.click(screen.getByRole("button", { name: "Unpushed" }));

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(expect.objectContaining({
				mode: "unpushed",
			}));
		});

		await user.click(screen.getByRole("button", { name: "Uncommitted" }));

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(expect.objectContaining({
				mode: "uncommitted",
			}));
		});
	});

	it("persists read state for the same unchanged file across reopen", async () => {
		const user = userEvent.setup();
		const view = render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");
		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));

		view.unmount();

		await act(async () => {
			render(
				<I18nProvider>
					<TaskDiffViewer
						task={task}
						project={project}
						request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
						onBack={vi.fn()}
					/>
				</I18nProvider>,
			);
		});

		await waitFor(() => {
			expect(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i })).toBeChecked();
			expect(screen.getAllByText("src/app.ts")[0]).toHaveClass("line-through");
			expect(screen.queryAllByTestId("mock-diff")).toHaveLength(1);
		});
	});

	it("scrolls to a requested file when opened from changed files popup", async () => {
		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main", focusFile: "src/utils/format.ts" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")).toHaveLength(2);
		});

		await waitFor(() => {
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});
	});

	it("renders a left file tree with collapsible folders", async () => {
		const user = userEvent.setup();

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")).toHaveLength(2);
		});

		expect(screen.getByText("Files")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open diff file src\/utils\/format\.ts/i })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^collapse folder src$/i }));

		expect(screen.queryByRole("button", { name: /open diff file src\/utils\/format\.ts/i })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^expand folder src$/i })).toBeInTheDocument();
	});

	it("follows the app light theme", async () => {
		document.documentElement.dataset.theme = "light";

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")[0]).toHaveTextContent("theme:light");
		});
	});
});
