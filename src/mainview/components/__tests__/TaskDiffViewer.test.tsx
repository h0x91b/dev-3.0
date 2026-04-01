import { render, screen, waitFor } from "@testing-library/react";
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
	DiffView: ({ diffViewMode }: { diffViewMode: number }) => <div data-testid="mock-diff">mode:{diffViewMode}</div>,
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
		files: 1,
		insertions: 3,
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
			newContent: "const a = 2;\n",
			hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n"],
		},
	],
	skippedBinaryFiles: [],
	skippedLargeFiles: [],
};

describe("TaskDiffViewer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.getTaskDiff).mockResolvedValue(diffPayload);
		localStorage.clear();
	});

	it("defaults to split mode and allows collapsing a file", async () => {
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
			expect(screen.getByTestId("mock-diff")).toHaveTextContent("mode:3");
		});

		await user.click(screen.getByRole("button", { name: /src\/app\.ts/i }));
		expect(screen.queryByTestId("mock-diff")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /src\/app\.ts/i }));
		expect(await screen.findByTestId("mock-diff")).toHaveTextContent("mode:3");
	});
});
