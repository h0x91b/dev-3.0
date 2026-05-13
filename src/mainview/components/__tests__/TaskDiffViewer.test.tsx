import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Task, TaskDiffResponse } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import type { NavigationGuard } from "../../navigation-guard";
import TaskDiffViewer from "../TaskDiffViewer";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskDiff: vi.fn(),
			getGlobalSettings: vi.fn(),
			showConfirm: vi.fn(),
		},
	},
}));

vi.mock("@git-diff-view/react", async () => {
	const React = await import("react");
	const SplitSide = {
		old: 0,
		new: 1,
	} as const;

	type MockDiffLine = {
		key: string;
		side: "old" | "new";
		text: string;
	};

	return {
		DiffView: ({
			diffViewMode,
			diffViewTheme,
			diffFile,
			diffViewAddWidget,
			renderWidgetLine,
			renderExtendLine,
			extendData,
		}: {
			diffViewMode: number;
			diffViewTheme: "dark" | "light";
			diffFile?: { __mockLines?: MockDiffLine[] };
			diffViewAddWidget?: boolean;
			renderWidgetLine?: (props: { lineNumber: number; side: number; onClose: () => void; diffFile: object }) => React.ReactNode;
			renderExtendLine?: (props: { lineNumber: number; side: number; data: unknown; onUpdate: () => void; diffFile: object }) => React.ReactNode;
			extendData?: {
				oldFile?: Record<string, { data: unknown }>;
				newFile?: Record<string, { data: unknown }>;
			};
		}) => {
			const [widget, setWidget] = React.useState<{ lineNumber: number; side: number } | null>(null);
			const [nextWidgetLineNumber, setNextWidgetLineNumber] = React.useState(1);
			const threadEntries = [
				...Object.entries(extendData?.oldFile ?? {}).map(([lineNumber, entry]) => ({
					key: `old-${lineNumber}`,
					lineNumber: Number(lineNumber),
					side: SplitSide.old,
					data: entry.data,
				})),
				...Object.entries(extendData?.newFile ?? {}).map(([lineNumber, entry]) => ({
					key: `new-${lineNumber}`,
					lineNumber: Number(lineNumber),
					side: SplitSide.new,
					data: entry.data,
				})),
			];

			return (
				<div className="diff-table-scroll-container overflow-x-auto" data-testid="mock-diff-scroll">
					<div data-testid="mock-diff">
						mode:{diffViewMode} theme:{diffViewTheme}
						<div className="space-y-1">
							{diffFile?.__mockLines?.map((line, index) => (
								<div key={line.key} data-line={index + 1} className="diff-line">
									<div className={line.side === "old" ? "diff-line-old-content" : "diff-line-new-content"}>
										<span data-testid="mock-search-line-content">{line.text}</span>
									</div>
								</div>
							))}
						</div>
						{diffViewAddWidget && (
							<button
								type="button"
								aria-label="Open inline comment composer"
								onClick={() => {
									setWidget({ lineNumber: nextWidgetLineNumber, side: SplitSide.new });
									setNextWidgetLineNumber((current) => current + 1);
								}}
							>
								+
							</button>
						)}
						{widget && renderWidgetLine && (
							<div data-testid="mock-widget">
								{renderWidgetLine({
									diffFile: {},
									side: widget.side,
									lineNumber: widget.lineNumber,
									onClose: () => setWidget(null),
								})}
							</div>
						)}
						{threadEntries.map((entry) => (
							<div key={entry.key} data-testid="mock-extend">
								{renderExtendLine?.({
									diffFile: {},
									side: entry.side,
									lineNumber: entry.lineNumber,
									data: entry.data,
									onUpdate: () => {},
								})}
							</div>
						))}
					</div>
				</div>
			);
		},
		DiffModeEnum: {
			Split: 3,
			Unified: 4,
		},
		SplitSide,
		DiffFile: class {
			__mockLines: MockDiffLine[];

			constructor(
				_oldFileName: string,
				oldFileContent: string,
				_newFileName: string,
				newFileContent: string,
			) {
				this.__mockLines = [
					...oldFileContent.split("\n").filter(Boolean).map((text, index) => ({
						key: `old-${index}`,
						side: "old" as const,
						text,
					})),
					...newFileContent.split("\n").filter(Boolean).map((text, index) => ({
						key: `new-${index}`,
						side: "new" as const,
						text,
					})),
				];
			}

			initTheme() {}
			initRaw() {}
			buildSplitDiffLines() {}
			buildUnifiedDiffLines() {}
		},
	};
});

vi.mock("@git-diff-view/file", () => ({
	generateDiffFile: (
		_oldFileName: string,
		oldFileContent: string,
		_newFileName: string,
		newFileContent: string,
	) => ({
		__mockLines: [
			...oldFileContent.split("\n").filter(Boolean).map((text, index) => ({
				key: `old-${index}`,
				side: "old" as const,
				text,
			})),
			...newFileContent.split("\n").filter(Boolean).map((text, index) => ({
				key: `new-${index}`,
				side: "new" as const,
				text,
			})),
		],
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
			oldContent: "const a = \"one\";\n",
			newContent: "const a = \"two\";\nconst b = 3;\n",
			hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n-const a = \"one\";\n+const a = \"two\";\n+const b = 3;\n"],
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
	skippedFiles: [],
};

function singleFilePayload(newContent: string, hunk: string, oldContent = "base\n"): TaskDiffResponse {
	return {
		mode: "branch",
		compareRef: "origin/main",
		compareLabel: "origin/main",
		fallbackReason: null,
		summary: {
			files: 1,
			insertions: 1,
			deletions: 1,
		},
		files: [
			{
				id: "src/app.ts",
				status: "modified",
				displayPath: "src/app.ts",
				oldPath: "src/app.ts",
				newPath: "src/app.ts",
				oldContent,
				newContent,
				hunks: [hunk],
			},
		],
		skippedFiles: [],
	};
}

describe("TaskDiffViewer", () => {
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;
	let lastScrolledText: string | null;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			...diffPayload,
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
		}));
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
		localStorage.clear();
		document.documentElement.dataset.theme = "dark";
		lastScrolledText = null;
		scrollIntoViewMock = vi.fn(function(this: HTMLElement) {
			lastScrolledText = this.textContent?.replace(/\s+/g, " ").trim() ?? null;
		});
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
		const viewerSummary = screen.getByText("3 files").parentElement;
		expect(viewerSummary).not.toBeNull();
		expect(within(viewerSummary as HTMLSpanElement).getByText("+5")).toHaveClass("text-success");
		expect(within(viewerSummary as HTMLSpanElement).getByText("−1")).toHaveClass("text-danger");
		const firstFileHeader = screen.getByRole("button", { name: /collapse src\/app\.ts/i }).closest("div");
		expect(firstFileHeader).toHaveClass("sticky");
		expect(firstFileHeader).not.toBeNull();
		expect(within(firstFileHeader as HTMLDivElement).getByText("+2")).toBeInTheDocument();
		expect(within(firstFileHeader as HTMLDivElement).getByText("−1")).toBeInTheDocument();

		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));

		expect(screen.getAllByText("src/app.ts")[0]).toHaveClass("line-through");
		expect(within(screen.getByRole("button", { name: /open diff file src\/app\.ts/i })).getByText("app.ts")).toHaveClass("line-through");
		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")).toHaveLength(1);
		});

		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));
		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff")).toHaveLength(2);
		});
	});

	it("renders binary and oversized skipped files with status, old→new sizes and reason badges", async () => {
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
			fallbackReason: null,
			summary: { files: 3, insertions: 0, deletions: 0 },
			files: [],
			skippedFiles: [
				{
					id: "assets/logo.png",
					status: "added",
					reason: "binary",
					displayPath: "assets/logo.png",
					oldPath: null,
					newPath: "assets/logo.png",
					oldSize: null,
					newSize: 45_000,
				},
				{
					id: "old.png",
					status: "renamed",
					reason: "binary",
					displayPath: "old.png -> new.png",
					oldPath: "old.png",
					newPath: "new.png",
					oldSize: 120_000,
					newSize: 130_000,
				},
				{
					id: "data/big.csv",
					status: "modified",
					reason: "too-large",
					displayPath: "data/big.csv",
					oldPath: "data/big.csv",
					newPath: "data/big.csv",
					oldSize: 300_000,
					newSize: 500_000,
				},
			],
		}));

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

		const section = await screen.findByTestId("diff-skipped-files");
		expect(within(section).getByText("Binary & large files")).toBeInTheDocument();
		expect(within(section).getByText("assets/logo.png")).toBeInTheDocument();
		expect(within(section).getByText("old.png")).toBeInTheDocument();
		expect(within(section).getByText("new.png")).toBeInTheDocument();
		expect(within(section).getByText("data/big.csv")).toBeInTheDocument();
		// Two "binary" + one "too large" reason badges
		expect(within(section).getAllByText("binary")).toHaveLength(2);
		expect(within(section).getByText("too large")).toBeInTheDocument();
		// Added file has no oldSize — rendered as em-dash, newSize formatted as "44 KB"
		expect(within(section).getByText(/44 KB/)).toBeInTheDocument();
		// Renamed binary shows old size formatted
		expect(within(section).getByText(/117 KB/)).toBeInTheDocument();
		expect(within(section).getByText(/127 KB/)).toBeInTheDocument();
	});

	it("lists binary/large files in the left file tree with Read checkbox, jump target, and counts them in read ratio", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
			fallbackReason: null,
			summary: { files: 2, insertions: 2, deletions: 0 },
			files: [
				{
					id: "src/app.ts",
					status: "modified",
					displayPath: "src/app.ts",
					oldPath: "src/app.ts",
					newPath: "src/app.ts",
					oldContent: "a\n",
					newContent: "b\n",
					hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n"],
				},
			],
			skippedFiles: [
				{
					id: "assets/logo.png",
					status: "added",
					reason: "binary",
					displayPath: "assets/logo.png",
					oldPath: null,
					newPath: "assets/logo.png",
					oldSize: null,
					newSize: 12_000,
				},
			],
		}));

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

		// Tree contains the skipped file
		const treeButton = await screen.findByRole("button", { name: /open diff file assets\/logo\.png/i });
		expect(treeButton).toBeInTheDocument();

		// Initial read ratio counts skipped in the total
		expect(screen.getByText(/0\/2\s+Read/i)).toBeInTheDocument();

		// Clicking the tree entry does not crash (jumps to the row)
		await user.click(treeButton);

		// Mark the skipped file as read via its row checkbox
		const skippedSection = screen.getByTestId("diff-skipped-files");
		const readCheckbox = within(skippedSection).getByRole("checkbox", { name: /mark assets\/logo\.png as read/i });
		await user.click(readCheckbox);

		// Read ratio updated
		expect(screen.getByText(/1\/2\s+Read/i)).toBeInTheDocument();
		// Tree label for the skipped file now has line-through
		expect(within(treeButton).getByText("logo.png")).toHaveClass("line-through");
	});

	it("uses unified as the initial layout when configured in global settings", async () => {
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			defaultDiffViewMode: "unified",
		});

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
			expect(screen.getAllByTestId("mock-diff")[0]).toHaveTextContent("mode:4 theme:dark");
		});
	});

	it("opens diff search and focuses it on Cmd+F", async () => {
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
		await user.keyboard("{Meta>}f{/Meta}");

		expect(screen.getByPlaceholderText("Search diff...")).toHaveFocus();
	});

	it("searches diff content and jumps to the matching line", async () => {
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
		await user.keyboard("{Meta>}f{/Meta}");
		await user.type(screen.getByPlaceholderText("Search diff..."), "ok");

		await waitFor(() => {
			expect(screen.getByText("1 / 1")).toBeInTheDocument();
		});
		await waitFor(() => {
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});
	});

	it("highlights the found diff text", async () => {
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
		await user.keyboard("{Meta>}f{/Meta}");
		await user.type(screen.getByPlaceholderText("Search diff..."), "ok");

		await waitFor(() => {
			expect(document.querySelectorAll(".dev3-diff-search-match-line").length).toBeGreaterThan(0);
		});
		expect(document.querySelector(".dev3-diff-search-current-line")).not.toBeNull();
	});

	it("moves through matches in top-to-bottom order with next and prev", async () => {
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
		await user.keyboard("{Meta>}f{/Meta}");
		await user.type(screen.getByPlaceholderText("Search diff..."), "const a = ");

		await waitFor(() => {
			expect(screen.getByText("1 / 2")).toBeInTheDocument();
			expect(lastScrolledText).toContain('const a = "one";');
		});

		await user.click(screen.getByRole("button", { name: "Next match" }));

		await waitFor(() => {
			expect(screen.getByText("2 / 2")).toBeInTheDocument();
			expect(lastScrolledText).toContain('const a = "two";');
		});

		await user.click(screen.getByRole("button", { name: "Previous match" }));

		await waitFor(() => {
			expect(screen.getByText("1 / 2")).toBeInTheDocument();
			expect(lastScrolledText).toContain('const a = "one";');
		});
	});

	it("does not add a second horizontal scroll wrapper around the diff view", async () => {
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

		const firstDiff = screen.getAllByTestId("mock-diff")[0];
		expect(firstDiff.parentElement).toHaveAttribute("data-testid", "mock-diff-scroll");
		expect(firstDiff.parentElement?.parentElement).not.toHaveClass("overflow-x-auto");
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

	it("does not reuse read state when file content changes behind the same hunk", async () => {
		const user = userEvent.setup();
		const stableHunk = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old value\n+new value\n";
		vi.mocked(api.request.getTaskDiff)
			.mockResolvedValueOnce(singleFilePayload("new value\ncontext one\n", stableHunk, "old value\ncontext one\n"))
			.mockResolvedValueOnce(singleFilePayload("new value\ncontext two\n", stableHunk, "old value\ncontext two\n"));

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

		await screen.findAllByText("context one");
		await user.click(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i }));
		await waitFor(() => {
			expect(screen.queryAllByText("context one")).toHaveLength(0);
		});

		view.unmount();

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
			expect(screen.getByRole("checkbox", { name: /mark src\/app\.ts as read/i })).not.toBeChecked();
		});
		expect((await screen.findAllByText("context two")).length).toBeGreaterThan(0);
	});

	it("refetches when the same diff request is opened again", async () => {
		const firstHunk = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-base\n+commit one\n";
		const secondHunk = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-base\n+commit two\n";
		vi.mocked(api.request.getTaskDiff)
			.mockResolvedValueOnce(singleFilePayload("commit one\n", firstHunk))
			.mockResolvedValueOnce(singleFilePayload("commit two\n", secondHunk));

		const { rerender } = render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findByText("commit one");
		expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenCalledTimes(1);

		rerender(
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
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenCalledTimes(2);
		});
		await screen.findByText("commit two");
		expect(screen.queryByText("commit one")).not.toBeInTheDocument();
	});

	it("scrolls to a requested file when opened from changed files popup", async () => {
		const rafQueue: FrameRequestCallback[] = [];
		const originalRequestAnimationFrame = window.requestAnimationFrame;
		const originalCancelAnimationFrame = window.cancelAnimationFrame;

		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			rafQueue.push(callback);
			return rafQueue.length;
		}) as typeof window.requestAnimationFrame;
		window.cancelAnimationFrame = vi.fn();

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

		const scrollRegion = screen.getByTestId("inline-diff-scroll-region");
		let scrollTop = 0;
		Object.defineProperty(scrollRegion, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = value;
			},
		});
		const scrollToMock = vi.fn(({ top }: ScrollToOptions) => {
			scrollTop = typeof top === "number" ? top : scrollTop;
		});
		Object.defineProperty(scrollRegion, "scrollTo", {
			configurable: true,
			value: scrollToMock,
		});
		Object.defineProperty(scrollRegion, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 120,
				bottom: 720,
				left: 0,
				right: 900,
				width: 900,
				height: 600,
				x: 0,
				y: 120,
				toJSON: () => ({}),
			}),
		});

		const toolbar = screen.getByTestId("inline-diff-toolbar");
		Object.defineProperty(toolbar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 0,
				bottom: 64,
				left: 0,
				right: 900,
				width: 900,
				height: 64,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		const targetSection = document.querySelector('[data-file-id="src/utils/format.ts"]') as HTMLDivElement | null;
		expect(targetSection).not.toBeNull();
		let targetRectCall = 0;
		Object.defineProperty(targetSection as HTMLDivElement, "getBoundingClientRect", {
			configurable: true,
			value: () => {
				targetRectCall += 1;
				const top = targetRectCall === 1 ? 480 : 192;
				return {
					top,
					bottom: top + 160,
					left: 0,
					right: 900,
					width: 900,
					height: 160,
					x: 0,
					y: top,
					toJSON: () => ({}),
				};
			},
		});

		while (rafQueue.length > 0) {
			const callback = rafQueue.shift();
			callback?.(performance.now());
		}

		expect(scrollToMock).toHaveBeenCalled();
		expect(scrollToMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ top: 288, behavior: "smooth" }));

		window.requestAnimationFrame = originalRequestAnimationFrame;
		window.cancelAnimationFrame = originalCancelAnimationFrame;
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

	it("supports bulk collapse and bulk read actions from the files sidebar", async () => {
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

		expect(screen.getByText("0/3 Read")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(screen.queryAllByTestId("mock-diff")).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Expand all" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Expand all" }));
		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});

		await user.click(screen.getByRole("button", { name: "Mark all read" }));
		expect(screen.getByText("3/3 Read")).toBeInTheDocument();
		expect(screen.queryAllByTestId("mock-diff")).toHaveLength(0);
		expect(within(screen.getByRole("button", { name: /open diff file src\/app\.ts/i })).getByText("app.ts")).toHaveClass("line-through");
		expect(screen.getByRole("button", { name: "Mark all unread" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Mark all unread" }));
		expect(screen.getByText("0/3 Read")).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});
	});

	it("retries sidebar file navigation until the target lands under the sticky toolbar", async () => {
		const user = userEvent.setup();
		const rafQueue: FrameRequestCallback[] = [];
		const originalRequestAnimationFrame = window.requestAnimationFrame;
		const originalCancelAnimationFrame = window.cancelAnimationFrame;

		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			rafQueue.push(callback);
			return rafQueue.length;
		}) as typeof window.requestAnimationFrame;
		window.cancelAnimationFrame = vi.fn();

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

		const scrollRegion = screen.getByTestId("inline-diff-scroll-region");
		let scrollTop = 0;
		Object.defineProperty(scrollRegion, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = value;
			},
		});

		const scrollToMock = vi.fn(({ top }: ScrollToOptions) => {
			scrollTop = typeof top === "number" ? top : scrollTop;
		});
		Object.defineProperty(scrollRegion, "scrollTo", {
			configurable: true,
			value: scrollToMock,
		});

		Object.defineProperty(scrollRegion, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 120,
				bottom: 720,
				left: 0,
				right: 900,
				width: 900,
				height: 600,
				x: 0,
				y: 120,
				toJSON: () => ({}),
			}),
		});

		const toolbar = screen.getByTestId("inline-diff-toolbar");
		Object.defineProperty(toolbar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 0,
				bottom: 64,
				left: 0,
				right: 900,
				width: 900,
				height: 64,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		const targetSection = document.querySelector('[data-file-id="docs/readme.md"]') as HTMLDivElement | null;
		expect(targetSection).not.toBeNull();
		let targetRectCall = 0;
		Object.defineProperty(targetSection as HTMLDivElement, "getBoundingClientRect", {
			configurable: true,
			value: () => {
				targetRectCall += 1;
				const top = targetRectCall === 1 ? 840 : targetRectCall === 2 ? 260 : 192;
				return {
					top,
					bottom: top + 200,
					left: 0,
					right: 900,
					width: 900,
					height: 200,
					x: 0,
					y: top,
					toJSON: () => ({}),
				};
			},
		});

		await user.click(screen.getByRole("button", { name: /open diff file docs\/readme\.md/i }));

		while (rafQueue.length > 0) {
			const callback = rafQueue.shift();
			callback?.(performance.now());
		}

		expect(scrollToMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(scrollToMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ top: 648, behavior: "smooth" }));
		expect(scrollToMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ top: 716, behavior: "auto" }));

		window.requestAnimationFrame = originalRequestAnimationFrame;
		window.cancelAnimationFrame = originalCancelAnimationFrame;
	});

	it("aligns a sticky file header before collapsing the file", async () => {
		const user = userEvent.setup();
		const rafQueue: FrameRequestCallback[] = [];
		const originalRequestAnimationFrame = window.requestAnimationFrame;
		const originalCancelAnimationFrame = window.cancelAnimationFrame;

		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			rafQueue.push(callback);
			return rafQueue.length;
		}) as typeof window.requestAnimationFrame;
		window.cancelAnimationFrame = vi.fn();

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

		const scrollRegion = screen.getByTestId("inline-diff-scroll-region");
		let scrollTop = 400;
		Object.defineProperty(scrollRegion, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = value;
			},
		});

		const scrollToMock = vi.fn(({ top }: ScrollToOptions) => {
			scrollTop = typeof top === "number" ? top : scrollTop;
		});
		Object.defineProperty(scrollRegion, "scrollTo", {
			configurable: true,
			value: scrollToMock,
		});

		Object.defineProperty(scrollRegion, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 120,
				bottom: 720,
				left: 0,
				right: 900,
				width: 900,
				height: 600,
				x: 0,
				y: 120,
				toJSON: () => ({}),
			}),
		});

		const toolbar = screen.getByTestId("inline-diff-toolbar");
		Object.defineProperty(toolbar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 0,
				bottom: 64,
				left: 0,
				right: 900,
				width: 900,
				height: 64,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		const targetSection = document.querySelector('[data-file-id="src/utils/format.ts"]') as HTMLDivElement | null;
		expect(targetSection).not.toBeNull();
		Object.defineProperty(targetSection as HTMLDivElement, "getBoundingClientRect", {
			configurable: true,
			value: () => {
				const top = scrollTop > 300 ? 80 : 194;
				return {
					top,
					bottom: top + 180,
					left: 0,
					right: 900,
					width: 900,
					height: 180,
					x: 0,
					y: top,
					toJSON: () => ({}),
				};
			},
		});

		await user.click(screen.getByRole("button", { name: /collapse src\/utils\/format\.ts/i }));

		await act(async () => {
			while (rafQueue.length > 0) {
				const callback = rafQueue.shift();
				callback?.(performance.now());
			}
		});

		expect(scrollToMock).toHaveBeenCalledWith(expect.objectContaining({ top: 288, behavior: "auto" }));
		await waitFor(() => {
			expect(screen.queryAllByTestId("mock-diff")).toHaveLength(1);
		});

		window.requestAnimationFrame = originalRequestAnimationFrame;
		window.cancelAnimationFrame = originalCancelAnimationFrame;
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

	it("copies the full worktree file path from a diff header", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

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

		await user.click(screen.getByRole("button", { name: "Copy full file path /tmp/wt/t1/src/app.ts" }));

		expect(writeText).toHaveBeenCalledWith("/tmp/wt/t1/src/app.ts");
		expect(screen.getByRole("button", { name: "Copied full file path /tmp/wt/t1/src/app.ts" })).toBeInTheDocument();
		expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
	});

	it("manages inline review comments from the sidebar and copies compact xml", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const longComment = 'Watch this branch edge case with "Show diff" label in the Russian locale. '.repeat(4).trim();
		const truncatedPreview = `${longComment.slice(0, 100)}...`;
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

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

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		expect(screen.getByTestId("mock-widget").querySelector(".dev3-inline-comment--composer")).not.toBeNull();

		await user.type(
			screen.getByPlaceholderText("Leave a comment on this line..."),
			longComment,
		);
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(screen.queryByPlaceholderText("Leave a comment on this line...")).not.toBeInTheDocument();
		expect(screen.getByText(longComment)).toBeInTheDocument();
		expect(screen.getByText("New line 1")).toBeInTheDocument();
		expect(document.querySelector(".dev3-inline-comment--thread")).not.toBeNull();
		expect(screen.queryByTestId("review-export-xml")).not.toBeInTheDocument();
		expect(screen.getByText("Comment 1")).toBeInTheDocument();
		expect(screen.getByText(truncatedPreview)).toBeInTheDocument();
		expect(screen.getByTestId("review-export-list")).toHaveClass("max-h-64", "overflow-y-auto");
		expect(screen.getByRole("button", { name: "Copy to Clipboard" })).toHaveClass("w-full");

		await user.click(screen.getByRole("button", { name: "Comment 1" }));
		await waitFor(() => {
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});

		await user.click(screen.getByRole("button", { name: "Copy to Clipboard" }));
		expect(writeText).toHaveBeenLastCalledWith([
			"<reviews>",
			"<review>",
			"<file src=\"src/app.ts\" line=1>",
			"-const a = \"one\";",
			"+const a = \"two\";",
			"</file>",
			`<comment>${longComment}</comment>`,
			"</review>",
			"</reviews>",
			"---",
			"Above my comments about code changes, read them carefully and process all of them.",
		].join("\n"));
		expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();

		const inlineThread = screen.getByTestId("inline-comment-thread");
		await user.click(within(inlineThread).getByRole("button", { name: "Edit comment" }));
		const sidebarEditor = screen.getByDisplayValue(longComment);
		await user.clear(sidebarEditor);
		await user.type(sidebarEditor, "Rename this callback.");
		await user.click(screen.getByRole("button", { name: "Save comment" }));

		expect(screen.getAllByText("Rename this callback.").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText(truncatedPreview)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Copy to Clipboard" }));
		expect(writeText).toHaveBeenCalledWith([
			"<reviews>",
			"<review>",
			"<file src=\"src/app.ts\" line=1>",
			"-const a = \"one\";",
			"+const a = \"two\";",
			"</file>",
			"<comment>Rename this callback.</comment>",
			"</review>",
			"</reviews>",
			"---",
			"Above my comments about code changes, read them carefully and process all of them.",
		].join("\n"));

		await user.click(within(screen.getByTestId("inline-comment-thread")).getByRole("button", { name: "Delete comment" }));
		expect(screen.queryByText("Comment 1")).not.toBeInTheDocument();
		expect(screen.queryByText("Rename this callback.")).not.toBeInTheDocument();
	});

	it("keeps the caret position while editing an inline comment", async () => {
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

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "abcdef");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		const inlineThread = screen.getByTestId("inline-comment-thread");
		await user.click(within(inlineThread).getByRole("button", { name: "Edit comment" }));

		const editor = screen.getByDisplayValue("abcdef") as HTMLTextAreaElement;
		editor.focus();
		editor.setSelectionRange(3, 3);
		await user.keyboard("XY");

		expect(editor.value).toBe("abcXYdef");
		expect(editor.selectionStart).toBe(5);
		expect(editor.selectionEnd).toBe(5);
	});

	it("finishes review card jump on the target comment instead of snapping back to file alignment", async () => {
		const user = userEvent.setup();
		const rafQueue: FrameRequestCallback[] = [];
		const originalRequestAnimationFrame = window.requestAnimationFrame;
		const originalCancelAnimationFrame = window.cancelAnimationFrame;

		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			rafQueue.push(callback);
			return rafQueue.length;
		}) as typeof window.requestAnimationFrame;
		window.cancelAnimationFrame = vi.fn();

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

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "first");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "second");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		const scrollRegion = screen.getByTestId("inline-diff-scroll-region");
		let scrollTop = 0;
		Object.defineProperty(scrollRegion, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = value;
			},
		});

		const scrollEvents: string[] = [];
		Object.defineProperty(scrollRegion, "scrollTo", {
			configurable: true,
			value: vi.fn(({ top }: ScrollToOptions) => {
				scrollEvents.push(`file:${String(top)}`);
				scrollTop = typeof top === "number" ? top : scrollTop;
			}),
		});

		Object.defineProperty(scrollRegion, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 120,
				bottom: 720,
				left: 0,
				right: 900,
				width: 900,
				height: 600,
				x: 0,
				y: 120,
				toJSON: () => ({}),
			}),
		});

		const toolbar = screen.getByTestId("inline-diff-toolbar");
		Object.defineProperty(toolbar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top: 0,
				bottom: 64,
				left: 0,
				right: 900,
				width: 900,
				height: 64,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		const targetSection = document.querySelector('[data-file-id="src/app.ts"]') as HTMLDivElement | null;
		expect(targetSection).not.toBeNull();
		let targetRectCall = 0;
		Object.defineProperty(targetSection as HTMLDivElement, "getBoundingClientRect", {
			configurable: true,
			value: () => {
				targetRectCall += 1;
				const top = targetRectCall === 1 ? 520 : targetRectCall === 2 ? 260 : 192;
				return {
					top,
					bottom: top + 220,
					left: 0,
					right: 900,
					width: 900,
					height: 220,
					x: 0,
					y: top,
					toJSON: () => ({}),
				};
			},
		});

		const secondComment = document.querySelector('[data-inline-comment-id*=":newFile:2:"]') as HTMLDivElement | null;
		expect(secondComment).not.toBeNull();
		Object.defineProperty(secondComment as HTMLDivElement, "scrollIntoView", {
			configurable: true,
			value: vi.fn(() => {
				scrollEvents.push("comment:2");
			}),
		});

		await user.click(screen.getByRole("button", { name: "Comment 2" }));

		while (rafQueue.length > 0) {
			const callback = rafQueue.shift();
			callback?.(performance.now());
		}

		expect(scrollEvents[scrollEvents.length - 1]).toBe("comment:2");

		window.requestAnimationFrame = originalRequestAnimationFrame;
		window.cancelAnimationFrame = originalCancelAnimationFrame;
	});

	it("closes immediately on Escape when there are no review comments", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const showConfirm = vi.mocked(api.request.showConfirm);
		showConfirm.mockResolvedValue(true);

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={onBack}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");
		await user.keyboard("{Escape}");

		expect(showConfirm).not.toHaveBeenCalled();
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("shows a confirm dialog before discarding unsaved review comments on Escape", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const showConfirm = vi.mocked(api.request.showConfirm);
		showConfirm.mockResolvedValueOnce(false);

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={onBack}
				/>
			</I18nProvider>,
		);

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "important note");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(showConfirm).toHaveBeenCalledTimes(1);
		});
		expect(onBack).not.toHaveBeenCalled();

		showConfirm.mockResolvedValueOnce(true);
		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(onBack).toHaveBeenCalledTimes(1);
		});
		expect(showConfirm).toHaveBeenCalledTimes(2);
	});

	it("registers a navigation guard that blocks app-level navigation and copies XML on save", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

		const guardRef: { current: NavigationGuard | null } = { current: null };

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
					navigationGuardRef={guardRef}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");
		expect(guardRef.current).not.toBeNull();
		expect(guardRef.current?.isDirty()).toBe(false);

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "guard me");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => {
			expect(guardRef.current?.isDirty()).toBe(true);
		});

		await act(async () => {
			await guardRef.current?.onSave();
		});

		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText.mock.calls[0][0]).toContain("<comment>guard me</comment>");
	});

	it("confirms before closing via the back button when unsaved review exists", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const showConfirm = vi.mocked(api.request.showConfirm);
		showConfirm.mockResolvedValue(true);

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={onBack}
				/>
			</I18nProvider>,
		);

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "note");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await user.click(screen.getByRole("button", { name: /Back to Terminal/i }));

		await waitFor(() => {
			expect(showConfirm).toHaveBeenCalledTimes(1);
			expect(onBack).toHaveBeenCalledTimes(1);
		});
	});
});
