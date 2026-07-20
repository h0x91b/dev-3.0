import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
			getTaskPrComments: vi.fn(),
			sendAgentMessageNow: vi.fn(),
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
			diffViewHighlight,
			renderWidgetLine,
			renderExtendLine,
			extendData,
			onCreateUseWidgetHook,
		}: {
			diffViewMode: number;
			diffViewTheme: "dark" | "light";
			diffFile?: { __mockLines?: MockDiffLine[] };
			diffViewAddWidget?: boolean;
			diffViewHighlight?: boolean;
			renderWidgetLine?: (props: { lineNumber: number; side: number; onClose: () => void; diffFile: object }) => React.ReactNode;
			renderExtendLine?: (props: { lineNumber: number; side: number; data?: unknown; onUpdate: () => void; diffFile: object }) => React.ReactNode;
			extendData?: {
				oldFile?: Record<string, { data: unknown }>;
				newFile?: Record<string, { data: unknown }>;
			};
			onCreateUseWidgetHook?: (hook: { getReadonlyState: () => { setWidget: (arg: { side?: number; lineNumber?: number }) => void } }) => void;
		}) => {
			const [widget, setWidget] = React.useState<{ lineNumber: number; side: number } | null>(null);
			const [nextWidgetLineNumber, setNextWidgetLineNumber] = React.useState(1);

			// Mirror the library's onCreateUseWidgetHook so production code can open
			// the composer programmatically (used by drag-to-select range commenting).
			React.useEffect(() => {
				onCreateUseWidgetHook?.({
					getReadonlyState: () => ({
						setWidget: ({ side, lineNumber }) => {
							if (typeof lineNumber === "number") {
								setWidget({ lineNumber, side: side ?? SplitSide.new });
							}
						},
					}),
				});
			}, [onCreateUseWidgetHook]);
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
					<div data-testid="mock-diff" data-diff-highlight={diffViewHighlight ? "1" : "0"}>
						mode:{diffViewMode} theme:{diffViewTheme}
						<div className="space-y-1">
							{(() => {
								let oldNum = 0;
								let newNum = 0;
								// Mirror both real gutter layouts: split uses `.diff-line-{old,new}-num`
								// with `[data-line-num]`; unified uses a single `.diff-line-num` cell
								// with `[data-line-old-num]`/`[data-line-new-num]` spans.
								const unified = diffViewMode === 4;
								return diffFile?.__mockLines?.map((line, index) => {
									const lineNumber = line.side === "old" ? (oldNum += 1) : (newNum += 1);
									return (
										<div key={line.key} data-line={index + 1} data-side={line.side} className="diff-line">
											{unified ? (
												<div className="diff-line-num">
													{line.side === "old"
														? <span data-line-old-num={lineNumber}>{lineNumber}</span>
														: <span data-line-new-num={lineNumber}>{lineNumber}</span>}
												</div>
											) : (
												<div className={line.side === "old" ? "diff-line-old-num" : "diff-line-new-num"}>
													<span data-line-num={lineNumber}>{lineNumber}</span>
												</div>
											)}
											<div className={line.side === "old" ? "diff-line-old-content" : "diff-line-new-content"}>
												<span data-testid="mock-search-line-content">{line.text}</span>
											</div>
										</div>
									);
								});
							})()}
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
							<React.Fragment key={entry.key}>
								<div data-testid="mock-extend">
									{renderExtendLine?.({
										diffFile: {},
										side: entry.side,
										lineNumber: entry.lineNumber,
										data: entry.data,
										onUpdate: () => {},
									})}
								</div>
								{diffViewMode === 3 && (
									<div data-testid="mock-empty-extend-counterpart">
										{renderExtendLine?.({
											diffFile: {},
											side: entry.side === SplitSide.old ? SplitSide.new : SplitSide.old,
											lineNumber: entry.lineNumber,
											data: undefined,
											onUpdate: () => {},
										})}
									</div>
								)}
							</React.Fragment>
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
			initSyntax() {}
			buildSplitDiffLines() {}
			buildUnifiedDiffLines() {}

		__lineIndexBySide(lineNumber: number, side: number): number {
			const sideName = side === 0 ? "old" : "new";
			let count = 0;
			for (let i = 0; i < this.__mockLines.length; i++) {
				if (this.__mockLines[i].side === sideName) {
					count += 1;
					if (count === lineNumber) return i;
				}
			}
			return -1;
		}

		getUnifiedLineIndexByLineNumber(lineNumber: number, side: number) {
			return this.__lineIndexBySide(lineNumber, side);
		}

		getUnifiedLine(_index: number) {
			return { isHidden: false };
		}

		getSplitLineIndexByLineNumber(lineNumber: number, side: number) {
			return this.__lineIndexBySide(lineNumber, side);
		}

		getSplitLeftLine(_index: number) {
			return { isHidden: false };
		}

		getSplitRightLine(_index: number) {
			return { isHidden: false };
		}
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
		initSyntax() {},
		buildSplitDiffLines() {},
		buildUnifiedDiffLines() {},
		getUnifiedLineIndexByLineNumber(this: { __mockLines: Array<{ side: string }> }, lineNumber: number, side: number) {
			const sideName = side === 0 ? "old" : "new";
			let count = 0;
			for (let i = 0; i < this.__mockLines.length; i++) {
				if (this.__mockLines[i].side === sideName) {
					count += 1;
					if (count === lineNumber) return i;
				}
			}
			return -1;
		},
		getUnifiedLine(_index: number) {
			return { isHidden: false };
		},
		getSplitLineIndexByLineNumber(this: { __mockLines: Array<{ side: string }> }, lineNumber: number, side: number) {
			const sideName = side === 0 ? "old" : "new";
			let count = 0;
			for (let i = 0; i < this.__mockLines.length; i++) {
				if (this.__mockLines[i].side === sideName) {
					count += 1;
					if (count === lineNumber) return i;
				}
			}
			return -1;
		},
		getSplitLeftLine(_index: number) {
			return { isHidden: false };
		},
		getSplitRightLine(_index: number) {
			return { isHidden: false };
		},
	}),
}));

const mockSetMaxLineToIgnoreSyntax = vi.fn();
vi.mock("@git-diff-view/core", () => ({
	highlighter: {
		setMaxLineToIgnoreSyntax: (value: number) => mockSetMaxLineToIgnoreSyntax(value),
	},
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	ConfirmHost: () => null,
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

const diffPayload: TaskDiffResponse = {
	mode: "branch",
	compareRef: "origin/main",
	compareLabel: "origin/main",
	fallbackReason: null,
	recentCount: null,
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
			insertions: 2,
			deletions: 1,
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
			insertions: 1,
			deletions: 0,
		},
		{
			id: "zzz/readme.md",
			status: "modified",
			displayPath: "zzz/readme.md",
			oldPath: "zzz/readme.md",
			newPath: "zzz/readme.md",
			oldContent: "old\n",
			newContent: "new\n",
			hunks: ["diff --git a/zzz/readme.md b/zzz/readme.md\n@@ -1 +1 @@\n-old\n+new\n"],
			insertions: 1,
			deletions: 1,
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
		recentCount: null,
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
				insertions: 1,
				deletions: 1,
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
		// Lock the screen width to a wide external-monitor size so the "auto"
		// default deterministically resolves to "split". Individual tests can
		// override this when they need to exercise the narrow-screen branch.
		Object.defineProperty(window.screen, "availWidth", {
			configurable: true,
			value: 2560,
		});
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

	it("enables syntax highlighting on the rendered diff view", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});

		for (const diff of screen.getAllByTestId("mock-diff")) {
			expect(diff).toHaveAttribute("data-diff-highlight", "1");
		}

		// The library skips highlighting files longer than 2000 lines by default;
		// the viewer raises that cap so large source files stay highlighted.
		expect(mockSetMaxLineToIgnoreSyntax).toHaveBeenCalled();
		const calls = mockSetMaxLineToIgnoreSyntax.mock.calls;
		const raisedTo = calls[calls.length - 1]?.[0] ?? 0;
		expect(raisedTo).toBeGreaterThan(2000);
	});

	it("sorts the right-panel file list alphabetically by full path", async () => {
		// Regression: git.ts assembles `files` as `[...trackedEntries, ...untrackedEntries]`,
		// so untracked files always end up at the bottom of the right panel while the left tree
		// shows them in their alphabetical position. The right panel must match the tree order.
		vi.mocked(api.request.getTaskDiff).mockResolvedValue({
			mode: "uncommitted",
			compareRef: null,
			compareLabel: "Working tree",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 3, insertions: 0, deletions: 0 },
			files: [
				{
					id: "src/management/handler.ts",
					status: "modified",
					displayPath: "src/management/handler.ts",
					oldPath: "src/management/handler.ts",
					newPath: "src/management/handler.ts",
					oldContent: "x\n",
					newContent: "y\n",
					hunks: ["diff --git a/src/management/handler.ts b/src/management/handler.ts\n@@ -1 +1 @@\n-x\n+y\n"],
					insertions: 1,
					deletions: 1,
				},
				{
					id: "src/utils/helper.ts",
					status: "modified",
					displayPath: "src/utils/helper.ts",
					oldPath: "src/utils/helper.ts",
					newPath: "src/utils/helper.ts",
					oldContent: "a\n",
					newContent: "b\n",
					hunks: ["diff --git a/src/utils/helper.ts b/src/utils/helper.ts\n@@ -1 +1 @@\n-a\n+b\n"],
					insertions: 1,
					deletions: 1,
				},
				// Backend appends untracked entries last — must be re-sorted into alphabetical position.
				{
					id: "src/migrations/0001_init.ts",
					status: "untracked",
					displayPath: "src/migrations/0001_init.ts",
					oldPath: null,
					newPath: "src/migrations/0001_init.ts",
					oldContent: "",
					newContent: "export {};\n",
					hunks: ["diff --git a/src/migrations/0001_init.ts b/src/migrations/0001_init.ts\n@@ -0,0 +1 @@\n+export {};\n"],
					insertions: 1,
					deletions: 0,
				},
			],
			skippedFiles: [],
		});

		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "uncommitted" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");
		const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-file-id]"));
		expect(sections.map((node) => node.dataset.fileId)).toEqual([
			"src/management/handler.ts",
			"src/migrations/0001_init.ts",
			"src/utils/helper.ts",
		]);
	});

	it("renders binary and oversized skipped files with status, old→new sizes and reason badges", async () => {
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
			fallbackReason: null,
			recentCount: null,
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
			recentCount: null,
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
					insertions: 1,
					deletions: 1,
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

	it("shows 'Showing N of M' badge with N <= M when 'Include tests' is off and there are skipped binary files", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) => ({
			mode,
			compareRef: mode === "uncommitted" ? null : "origin/main",
			compareLabel: mode === "uncommitted" ? "Working tree" : "origin/main",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 3, insertions: 1, deletions: 1 },
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
					insertions: 1,
					deletions: 1,
				},
				{
					id: "src/app.test.ts",
					status: "modified",
					displayPath: "src/app.test.ts",
					oldPath: "src/app.test.ts",
					newPath: "src/app.test.ts",
					oldContent: "t\n",
					newContent: "u\n",
					hunks: ["diff --git a/src/app.test.ts b/src/app.test.ts\n@@ -1 +1 @@\n-t\n+u\n"],
					insertions: 1,
					deletions: 1,
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

		const checkbox = await screen.findByRole("checkbox", { name: /include tests/i });
		expect(checkbox).toBeChecked();
		await user.click(checkbox);
		expect(checkbox).not.toBeChecked();

		// Badge must read "Showing 2 of 3" — 1 code file + 1 skipped binary visible, 1 test file hidden.
		// Regression: previously rendered "Showing 2 of 1" because the total excluded skipped files.
		const badge = await screen.findByText(/Showing\s+2\s+of\s+3\s+changed files/i);
		expect(badge).toBeInTheDocument();
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

	it("auto mode picks unified on a laptop-sized screen", async () => {
		Object.defineProperty(window.screen, "availWidth", {
			configurable: true,
			value: 1512,
		});
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			defaultDiffViewMode: "auto",
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

	it("auto mode picks split on a large external monitor", async () => {
		Object.defineProperty(window.screen, "availWidth", {
			configurable: true,
			value: 2560,
		});
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			defaultDiffViewMode: "auto",
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
			expect(screen.getAllByTestId("mock-diff")[0]).toHaveTextContent("mode:3 theme:dark");
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

	it("'Mark all unread' clears read state for hidden test files too", async () => {
		// Regression: setAllFilesRead used to iterate only over visibleFiles, so
		// when "Include tests" was OFF, clicking "Mark all unread" left previously
		// read test files marked as read in both in-memory state and localStorage.
		const payloadWithTest: TaskDiffResponse = {
			mode: "branch",
			compareRef: "origin/main",
			compareLabel: "origin/main",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 2, insertions: 2, deletions: 0 },
			files: [
				{
					id: "src/app.ts",
					status: "modified",
					displayPath: "src/app.ts",
					oldPath: "src/app.ts",
					newPath: "src/app.ts",
					oldContent: "a\n",
					newContent: "a\nb\n",
					hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n a\n+b\n"],
					insertions: 1,
					deletions: 0,
				},
				{
					id: "src/app.test.ts",
					status: "modified",
					displayPath: "src/app.test.ts",
					oldPath: "src/app.test.ts",
					newPath: "src/app.test.ts",
					oldContent: "x\n",
					newContent: "x\ny\n",
					hunks: ["diff --git a/src/app.test.ts b/src/app.test.ts\n@@ -1 +1,2 @@\n x\n+y\n"],
					insertions: 1,
					deletions: 0,
				},
			],
			skippedFiles: [],
		};
		vi.mocked(api.request.getTaskDiff).mockResolvedValue(payloadWithTest);

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

		// Step 1: with "Include tests" ON (default), mark all files as read.
		expect(screen.getByText("0/2 Read")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Mark all read" }));
		expect(screen.getByText("2/2 Read")).toBeInTheDocument();

		// Step 2: toggle "Include tests" OFF — only the production file is visible.
		await user.click(screen.getByTestId("diff-toolbar-include-tests").querySelector("input")!);
		expect(screen.getByText("1/1 Read")).toBeInTheDocument();

		// Step 3: with the test file hidden, click "Mark all unread".
		await user.click(screen.getByRole("button", { name: "Mark all unread" }));
		expect(screen.getByText("0/1 Read")).toBeInTheDocument();

		// Step 4: toggle "Include tests" back ON — the previously hidden test
		// file must also be unread now (this was the bug: it stayed "1/2 Read").
		await user.click(screen.getByTestId("diff-toolbar-include-tests").querySelector("input")!);
		expect(screen.getByText("0/2 Read")).toBeInTheDocument();
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

		const targetSection = document.querySelector('[data-file-id="zzz/readme.md"]') as HTMLDivElement | null;
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

		await user.click(screen.getByRole("button", { name: /open diff file zzz\/readme\.md/i }));

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

	it("keeps split view open when a comment has no extension data on the opposite side", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			defaultDiffViewMode: "split",
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

		const diffs = await screen.findAllByTestId("mock-diff");
		expect(diffs[0]).toHaveTextContent("mode:3");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "one-sided comment");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(screen.getAllByText("one-sided comment").length).toBeGreaterThan(0);
		expect(screen.getAllByTestId("mock-empty-extend-counterpart").length).toBeGreaterThan(0);
		expect(screen.getAllByTestId("mock-diff")).toHaveLength(2);
	});

	it("drag-selects a line range in the gutter and comments on the whole range", async () => {
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
		const section = diffs[0];
		const newNums = section.querySelectorAll<HTMLElement>(".diff-line-new-num [data-line-num]");
		// src/app.ts adds two new lines (1 and 2).
		expect(newNums.length).toBeGreaterThanOrEqual(2);

		// Press on line 1, drag to line 2, release — selects the [1, 2] range.
		fireEvent.mouseDown(newNums[0], { button: 0 });
		fireEvent.mouseMove(newNums[1]);
		fireEvent.mouseUp(newNums[1]);

		// The composer opens anchored to the bottom line, labelled with the range.
		const composer = await screen.findByText(/New lines 1–2/);
		expect(composer).toBeInTheDocument();

		await user.type(
			screen.getByPlaceholderText("Leave a comment on this line..."),
			"Refactor this block",
		);
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(screen.getAllByText("Refactor this block").length).toBeGreaterThanOrEqual(1);
		// The persisted thread header reflects the multi-line range.
		expect(
			within(screen.getByTestId("inline-comment-thread")).getByText("New lines 1–2"),
		).toBeInTheDocument();
		expect(document.querySelector('[data-inline-comment-id*=":newFile:1-2:"]')).not.toBeNull();
	});

	it("drag-selects a line range in unified mode where the gutter is one combined column", async () => {
		const user = userEvent.setup();
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
			expect(screen.getAllByTestId("mock-diff")[0]).toHaveTextContent("mode:4");
		});

		const section = screen.getAllByTestId("mock-diff")[0];
		// Unified gutter: a single `.diff-line-num` cell with `[data-line-new-num]` spans.
		const newNums = section.querySelectorAll<HTMLElement>(".diff-line-num [data-line-new-num]");
		expect(newNums.length).toBeGreaterThanOrEqual(2);

		fireEvent.mouseDown(newNums[0], { button: 0 });
		fireEvent.mouseMove(newNums[1]);
		fireEvent.mouseUp(newNums[1]);

		const composer = await screen.findByText(/New lines 1–2/);
		expect(composer).toBeInTheDocument();

		await user.type(
			screen.getByPlaceholderText("Leave a comment on this line..."),
			"Unified range note",
		);
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(
			within(screen.getByTestId("inline-comment-thread")).getByText("New lines 1–2"),
		).toBeInTheDocument();
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
		const showConfirm = vi.mocked(confirm);
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

	it("closes immediately on Escape even with review comments (review persists)", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const showConfirm = vi.mocked(confirm);
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
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "important note");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(onBack).toHaveBeenCalledTimes(1);
		});
		expect(showConfirm).not.toHaveBeenCalled();
	});

	it("never registers a navigation guard — the persisted review is never dirty", async () => {
		const user = userEvent.setup();
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

		const diffs = await screen.findAllByTestId("mock-diff");
		expect(guardRef.current).toBeNull();

		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "guard me");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		// Adding comments must not arm the shared unsaved-changes modal: the review
		// is durable, so leaving never risks data loss.
		expect(guardRef.current).toBeNull();
	});

	it("closes via the back button immediately even with review comments", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const showConfirm = vi.mocked(confirm);
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
			expect(onBack).toHaveBeenCalledTimes(1);
		});
		expect(showConfirm).not.toHaveBeenCalled();
	});

	it("closes without prompting after the review XML has been copied to the clipboard", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		const showConfirm = vi.mocked(confirm);

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
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "looks good");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await user.click(screen.getByRole("button", { name: /Copy to Clipboard/i }));
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledTimes(1);
		});

		await user.click(screen.getByRole("button", { name: /Back to Terminal/i }));

		await waitFor(() => {
			expect(onBack).toHaveBeenCalledTimes(1);
		});
		expect(showConfirm).not.toHaveBeenCalled();
	});

	it("persists the review to localStorage and restores it after a remount", async () => {
		const user = userEvent.setup();
		const reviewKey = "dev3-inline-diff-review-v1:t1";

		const first = render(
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
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "persist me");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => {
			expect(localStorage.getItem(reviewKey)).toContain("persist me");
		});

		// Unmount and remount — the review must come back from localStorage rather
		// than being wiped, the way it used to be on every diff (re)load.
		first.unmount();

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
		await waitFor(() => {
			expect(screen.getAllByText("persist me").length).toBeGreaterThan(0);
		});
		expect(screen.getByText("Comment 1")).toBeInTheDocument();
	});

	it("sweeps expired and corrupt review entries for other tasks on mount", async () => {
		const dayMs = 24 * 60 * 60 * 1000;
		const expiredKey = "dev3-inline-diff-review-v1:other-old";
		const freshKey = "dev3-inline-diff-review-v1:other-fresh";
		const corruptKey = "dev3-inline-diff-review-v1:other-broken";
		const unrelatedKey = "some-other-app-key";

		localStorage.setItem(expiredKey, JSON.stringify({ savedAt: Date.now() - (3 * dayMs + 60_000), comments: { f: 1 } }));
		localStorage.setItem(freshKey, JSON.stringify({ savedAt: Date.now() - dayMs, comments: { f: 1 } }));
		localStorage.setItem(corruptKey, "{not json");
		localStorage.setItem(unrelatedKey, "keep me");

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

		await waitFor(() => {
			expect(localStorage.getItem(expiredKey)).toBeNull();
		});
		expect(localStorage.getItem(corruptKey)).toBeNull();
		// A still-fresh review for another task and unrelated keys are left alone.
		expect(localStorage.getItem(freshKey)).not.toBeNull();
		expect(localStorage.getItem(unrelatedKey)).toBe("keep me");
	});

	it("drops a persisted review older than the 3-day TTL instead of restoring it", async () => {
		const user = userEvent.setup();
		const reviewKey = "dev3-inline-diff-review-v1:t1";

		const first = render(
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
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "stale note");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => {
			expect(localStorage.getItem(reviewKey)).toContain("stale note");
		});

		// Backdate the stored review past the 3-day retention window.
		const stored = JSON.parse(localStorage.getItem(reviewKey) as string);
		stored.savedAt = Date.now() - (3 * 24 * 60 * 60 * 1000 + 60_000);
		localStorage.setItem(reviewKey, JSON.stringify(stored));

		first.unmount();

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
		// Expired review must not come back, and the stale entry must be purged.
		expect(screen.queryAllByText("stale note")).toHaveLength(0);
		expect(screen.queryByTestId("review-reset-button")).not.toBeInTheDocument();
		await waitFor(() => {
			expect(localStorage.getItem(reviewKey)).toBeNull();
		});
	});

	it("Reset review clears comments and storage after confirmation, and is hidden when empty", async () => {
		const user = userEvent.setup();
		const reviewKey = "dev3-inline-diff-review-v1:t1";
		const showConfirm = vi.mocked(confirm);

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
		// No comments yet → the Reset control must not be rendered.
		expect(screen.queryByTestId("review-reset-button")).not.toBeInTheDocument();

		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "kill me");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => {
			expect(localStorage.getItem(reviewKey)).toContain("kill me");
		});
		const resetButton = screen.getByTestId("review-reset-button");

		// Declining the confirm keeps the review intact.
		showConfirm.mockResolvedValueOnce(false);
		await user.click(resetButton);
		await waitFor(() => {
			expect(showConfirm).toHaveBeenCalledTimes(1);
		});
		expect(screen.getAllByText("kill me").length).toBeGreaterThan(0);
		expect(localStorage.getItem(reviewKey)).toContain("kill me");

		// Confirming wipes the comments and removes the persisted entry.
		showConfirm.mockResolvedValueOnce(true);
		await user.click(resetButton);

		await waitFor(() => {
			expect(screen.queryAllByText("kill me")).toHaveLength(0);
		});
		expect(screen.queryByTestId("review-reset-button")).not.toBeInTheDocument();
		expect(localStorage.getItem(reviewKey)).toBeNull();
	});

	it("still saves new comments when the existing localStorage entry is corrupt JSON", async () => {
		const user = userEvent.setup();
		const reviewKey = "dev3-inline-diff-review-v1:t1";

		// Seed a corrupt entry for this task so JSON.parse throws on the first write attempt.
		localStorage.setItem(reviewKey, "{not valid json");

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
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "after corrupt");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		// The write must succeed despite the corrupt existing entry — not be silently
		// swallowed by the outer catch that would have wrapped the inner JSON.parse.
		await waitFor(() => {
			expect(localStorage.getItem(reviewKey)).toContain("after corrupt");
		});
	});

	it("does not write task A review to task B storage when task.id changes mid-render", async () => {
		const user = userEvent.setup();
		const reviewKeyA = "dev3-inline-diff-review-v1:t1";
		const reviewKeyB = "dev3-inline-diff-review-v1:t2";
		const taskB: Task = { ...task, id: "t2", worktreePath: "/tmp/wt/t2", branchName: "dev3/task-t2" };

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

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "task A note");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => {
			expect(localStorage.getItem(reviewKeyA)).toContain("task A note");
		});

		// Simulate the user clicking a different task in the kanban while the diff viewer
		// is still mounted — useTaskInlineDiffState resets inlineDiffRequest to null one
		// render later, but during that intermediate render task.id has already advanced.
		// The persist effect must not cross-write task A's review under task B's key.
		rerender(
			<I18nProvider>
				<TaskDiffViewer
					task={taskB}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		// Give React a moment to flush all effects from the re-render.
		await waitFor(() => {
			expect(localStorage.getItem(reviewKeyA)).toContain("task A note");
		});
		// Task B's storage must NOT have been seeded with task A's review data.
		expect(localStorage.getItem(reviewKeyB)).toBeNull();
	});

	it("opens the diff viewer in uncommitted mode by default even when the caller requested branch mode", async () => {
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

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(expect.objectContaining({
				mode: "uncommitted",
			}));
		});
	});

	it("remembers the most recently selected diff mode across opens", async () => {
		const user = userEvent.setup();

		const first = render(
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

		first.unmount();

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

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(expect.objectContaining({
				mode: "unpushed",
			}));
		});
	});

	it("honors caller-provided mode when a specific file is requested (focusFile)", async () => {
		render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main", focusFile: "src/app.ts" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findAllByTestId("mock-diff");

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(expect.objectContaining({
				mode: "branch",
			}));
		});
	});

	it("collapses the files panel and persists the preference in localStorage", async () => {
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

		// Default: files panel visible, no expand strip.
		expect(screen.queryByTestId("diff-files-expand-strip")).toBeNull();
		const collapseBtn = screen.getByTestId("diff-files-collapse-button");

		await user.click(collapseBtn);

		// After collapse: expand strip is shown, files panel button is gone.
		expect(screen.queryByTestId("diff-files-collapse-button")).toBeNull();
		expect(screen.getByTestId("diff-files-expand-strip")).toBeInTheDocument();
		expect(localStorage.getItem("dev3-inline-diff-files-collapsed-v1")).toBe("1");

		// Expand again via the strip.
		await user.click(screen.getByTestId("diff-files-expand-strip"));
		expect(screen.queryByTestId("diff-files-expand-strip")).toBeNull();
		expect(screen.getByTestId("diff-files-collapse-button")).toBeInTheDocument();
		expect(localStorage.getItem("dev3-inline-diff-files-collapsed-v1")).toBe("0");
	});

	it("restores the collapsed files panel state from localStorage on mount", async () => {
		localStorage.setItem("dev3-inline-diff-files-collapsed-v1", "1");

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

		expect(screen.getByTestId("diff-files-expand-strip")).toBeInTheDocument();
		expect(screen.queryByTestId("diff-files-collapse-button")).toBeNull();
	});

	it("shows a dedicated empty state (not 'No changes') when every file is a hidden test", async () => {
		// User has previously disabled "Include tests".
		localStorage.setItem("dev3-diff-include-tests-v1", "0");

		const testsOnlyPayload: TaskDiffResponse = {
			mode: "branch",
			compareRef: "origin/main",
			compareLabel: "origin/main",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 2, insertions: 2, deletions: 0 },
			files: [
				{
					id: "src/foo.test.ts",
					status: "added",
					displayPath: "src/foo.test.ts",
					oldPath: null,
					newPath: "src/foo.test.ts",
					oldContent: "",
					newContent: "export const t = 1;\n",
					hunks: ["diff --git a/src/foo.test.ts b/src/foo.test.ts\n@@ -0,0 +1 @@\n+export const t = 1;\n"],
					insertions: 1,
					deletions: 0,
				},
				{
					id: "src/__tests__/bar.spec.tsx",
					status: "added",
					displayPath: "src/__tests__/bar.spec.tsx",
					oldPath: null,
					newPath: "src/__tests__/bar.spec.tsx",
					oldContent: "",
					newContent: "export const u = 2;\n",
					hunks: ["diff --git a/src/__tests__/bar.spec.tsx b/src/__tests__/bar.spec.tsx\n@@ -0,0 +1 @@\n+export const u = 2;\n"],
					insertions: 1,
					deletions: 0,
				},
			],
			skippedFiles: [],
		};
		vi.mocked(api.request.getTaskDiff).mockResolvedValue(testsOnlyPayload);

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

		// The dedicated empty state appears — not the generic "No changes to show".
		const emptyState = await screen.findByTestId("diff-only-tests-empty-state");
		expect(emptyState).toBeInTheDocument();
		expect(within(emptyState).getByText(/Only test files in this diff/i)).toBeInTheDocument();
		expect(within(emptyState).getByText(/2 test files are hidden/i)).toBeInTheDocument();
		expect(screen.queryByText("No changes to show")).toBeNull();
		expect(screen.queryByText("This diff is empty for the selected mode.")).toBeNull();

		// Clicking the action button re-enables the tests filter.
		await user.click(screen.getByTestId("diff-only-tests-enable-button"));

		expect(localStorage.getItem("dev3-diff-include-tests-v1")).toBe("1");
		await waitFor(() => {
			expect(screen.queryByTestId("diff-only-tests-empty-state")).toBeNull();
		});
		await screen.findAllByTestId("mock-diff");
	});
});

describe("TaskDiffViewer narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

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
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
		Object.defineProperty(window.screen, "availWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("hides the Split toggle and moves the file list into a bottom sheet", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});

		// Split view is unusable at phone width — its toggle is not rendered.
		expect(screen.queryByRole("button", { name: "Split" })).not.toBeInTheDocument();

		// The files aside is not inline; a "Files" button opens it in a bottom sheet.
		expect(screen.queryByTestId("diff-files-sheet")).not.toBeInTheDocument();
		await user.click(screen.getByTestId("diff-files-sheet-trigger"));
		expect(await screen.findByTestId("diff-files-sheet")).toBeInTheDocument();
	});

	it("uses the structured narrow toolbar: icon back button, stats in the subtitle", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});

		// Row 1: the back button collapses to an icon with an accessible name —
		// the full "Back to Terminal" label would crush the title at 390px.
		const back = screen.getByRole("button", { name: "Back to Terminal" });
		expect(back).not.toHaveTextContent("Back to Terminal");

		// Insertion/deletion stats fold into the subtitle line instead of a
		// separate chip; the file count lives on the Files sheet trigger.
		const subtitle = screen.getByTestId("diff-narrow-subtitle");
		expect(subtitle).toHaveTextContent("+5");
		expect(subtitle).toHaveTextContent("−1");
		expect(screen.queryByTestId("diff-toolbar-summary")).not.toBeInTheDocument();
		expect(screen.getByTestId("diff-files-sheet-trigger")).toHaveTextContent("Files (3)");
	});

	it("opens the search as a full-width row on narrow", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});

		expect(screen.queryByTestId("diff-narrow-search-row")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Search diff" }));
		expect(screen.getByTestId("diff-narrow-search-row")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Search diff...")).toBeInTheDocument();
	});

	it("keeps all four mode toggles reachable on narrow", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});
		expect(screen.getByRole("button", { name: "Branch" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Uncommitted" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Unpushed" })).toBeInTheDocument();
		expect(screen.getByTestId("diff-mode-recent")).toBeInTheDocument();
	});

	it("scrolls the mode/filter row with the content instead of pinning it", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});
		const scrollRegion = screen.getByTestId("inline-diff-scroll-region");
		const toolbar = screen.getByTestId("inline-diff-toolbar");
		// The mode switcher lives at the top of the scroll region (scrolls away
		// with the content); the pinned toolbar keeps only nav + search + files.
		expect(within(scrollRegion).getByRole("button", { name: "Uncommitted" })).toBeInTheDocument();
		expect(within(toolbar).queryByRole("button", { name: "Uncommitted" })).not.toBeInTheDocument();
	});

	it("renders file paths as one truncating line (dir + basename) on narrow", async () => {
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
			expect(screen.getAllByTestId("mock-diff").length).toBeGreaterThan(0);
		});
		// The directory part and the basename render as separate spans: the
		// directory truncates while the file name itself always stays visible.
		expect(screen.getAllByText("src/").length).toBeGreaterThan(0);
		expect(screen.getAllByText("app.ts").length).toBeGreaterThan(0);
	});
});

describe("TaskDiffViewer — recent commits mode", () => {
	// A recent-aware mock: for `recent` it echoes the requested count clamped to 3
	// (a pretend 3-own-commit branch); other modes reuse the shared branch payload.
	function recentAwareDiff(count?: number): TaskDiffResponse {
		const effective = Math.min(count ?? 1, 3);
		return {
			mode: "recent",
			compareRef: effective > 0 ? `HEAD~${effective}` : null,
			compareLabel: `HEAD~${effective}`,
			fallbackReason: null,
			recentCount: effective,
			summary: { files: effective > 0 ? 1 : 0, insertions: 1, deletions: 0 },
			files: effective > 0
				? [{
					id: "c.ts",
					status: "added",
					displayPath: "c.ts",
					oldPath: null,
					newPath: "c.ts",
					oldContent: "",
					newContent: "export const c = 3;\n",
					hunks: null,
					insertions: 1,
					deletions: 0,
				}]
				: [],
			skippedFiles: [],
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode, count }) =>
			mode === "recent"
				? recentAwareDiff(count)
				: { ...diffPayload, mode, compareRef: "origin/main", compareLabel: "origin/main" },
		);
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
		localStorage.clear();
		document.documentElement.dataset.theme = "dark";
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
		Object.defineProperty(window.screen, "availWidth", { configurable: true, value: 2560 });
	});

	function renderViewer() {
		return render(
			<I18nProvider>
				<TaskDiffViewer
					task={task}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);
	}

	it("renders the recent split-button labeled 'Last commit'", async () => {
		renderViewer();
		const body = await screen.findByTestId("diff-mode-recent");
		expect(body).toHaveTextContent("Last commit");
		expect(screen.getByTestId("diff-mode-recent-caret")).toBeInTheDocument();
		// Popover is closed until the caret is clicked.
		expect(screen.queryByTestId("diff-mode-recent-menu")).not.toBeInTheDocument();
	});

	it("activates recent mode with count 1 when the button body is clicked", async () => {
		const user = userEvent.setup();
		renderViewer();
		await screen.findByTestId("diff-mode-recent");

		await user.click(screen.getByTestId("diff-mode-recent"));

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: "recent", count: 1 }),
			);
		});
	});

	it("opens the preset popover from the caret", async () => {
		const user = userEvent.setup();
		renderViewer();
		await screen.findByTestId("diff-mode-recent-caret");

		await user.click(screen.getByTestId("diff-mode-recent-caret"));

		const menu = await screen.findByTestId("diff-mode-recent-menu");
		expect(menu).toBeInTheDocument();
		// All five presets are offered.
		for (const n of [1, 2, 3, 5, 10]) {
			expect(screen.getByTestId(`diff-recent-preset-${n}`)).toBeInTheDocument();
		}
	});

	it("selecting a preset sets the count and activates recent mode", async () => {
		const user = userEvent.setup();
		renderViewer();
		await screen.findByTestId("diff-mode-recent-caret");

		await user.click(screen.getByTestId("diff-mode-recent-caret"));
		await user.click(await screen.findByTestId("diff-recent-preset-3"));

		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: "recent", count: 3 }),
			);
		});
		// Popover closes after selection.
		expect(screen.queryByTestId("diff-mode-recent-menu")).not.toBeInTheDocument();
		// The body label reflects the selected N.
		expect(screen.getByTestId("diff-mode-recent")).toHaveTextContent("Last 3 commits");
	});

	it("resets N to 1 on reopen even though recent mode stays the preference", async () => {
		const user = userEvent.setup();
		const { rerender } = renderViewer();
		await screen.findByTestId("diff-mode-recent-caret");

		// Pick N=3, which also persists `recent` as the mode preference.
		await user.click(screen.getByTestId("diff-mode-recent-caret"));
		await user.click(await screen.findByTestId("diff-recent-preset-3"));
		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: "recent", count: 3 }),
			);
		});

		// Reopen with a fresh request object → mode preference is still recent, but N resets to 1.
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
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: "recent", count: 1 }),
			);
		});
		expect(screen.getByTestId("diff-mode-recent")).toHaveTextContent("Last commit");
	});

	it("shows the empty state when the branch has no commits of its own", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.getTaskDiff).mockImplementation(async ({ mode }) =>
			mode === "recent"
				? recentAwareDiff(0)
				: { ...diffPayload, mode, compareRef: "origin/main", compareLabel: "origin/main" },
		);
		renderViewer();
		await screen.findByTestId("diff-mode-recent");

		await user.click(screen.getByTestId("diff-mode-recent"));

		expect(await screen.findByText("No changes to show")).toBeInTheDocument();
		// Header reflects the honest "no commits" state, and the button stays enabled.
		expect(screen.getByText("No commits on this branch yet")).toBeInTheDocument();
		expect(screen.getByTestId("diff-mode-recent")).toBeEnabled();
	});
});

describe("TaskDiffViewer — GitHub PR review layer", () => {
	const prTask: Task = { ...task, prNumber: 42, prUrl: "https://github.com/acme/widget/pull/42" };

	function makeThread(overrides: Record<string, unknown> = {}) {
		return {
			id: "th1",
			path: "src/app.ts",
			line: 1,
			originalLine: 1,
			startLine: null,
			diffSide: "RIGHT" as const,
			isResolved: false,
			isOutdated: false,
			comments: [
				{
					id: "c1",
					author: "alice",
					isBot: false,
					body: "Rename **this** variable.",
					createdAt: "2026-07-18T10:00:00Z",
					url: "https://github.com/acme/widget/pull/42#discussion_r1",
				},
			],
			...overrides,
		};
	}

	function makePrPayload(overrides: Record<string, unknown> = {}) {
		return {
			prNumber: 42,
			prUrl: "https://github.com/acme/widget/pull/42",
			fetchedAt: "2026-07-19T08:00:00Z",
			threads: [makeThread()],
			conversation: [
				{
					id: "ic1",
					author: "codex-bot[bot]",
					isBot: true,
					body: "LGTM but check the tests.",
					createdAt: "2026-07-18T11:00:00Z",
					url: "https://github.com/acme/widget/pull/42#issuecomment-1",
				},
			],
			...overrides,
		};
	}

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
		} as never);
		vi.mocked(api.request.getTaskPrComments).mockResolvedValue(makePrPayload() as never);
		vi.mocked(api.request.sendAgentMessageNow).mockResolvedValue(undefined as never);
		localStorage.clear();
		// Inline thread anchoring is branch-mode only; open the viewer there.
		localStorage.setItem("dev3-inline-diff-mode-v1", "branch");
		document.documentElement.dataset.theme = "dark";
		Object.defineProperty(window.screen, "availWidth", {
			configurable: true,
			value: 2560,
		});
	});

	function renderViewer(viewerTask: Task = prTask) {
		return render(
			<I18nProvider>
				<TaskDiffViewer
					task={viewerTask}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main" }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);
	}

	it("skips the PR comments fetch entirely when the task has no PR", async () => {
		renderViewer(task);
		await screen.findAllByTestId("mock-diff");
		expect(api.request.getTaskPrComments).not.toHaveBeenCalled();
		expect(screen.queryByTestId("pr-conversation-block")).not.toBeInTheDocument();
	});

	it("renders the conversation block and anchors the thread inline in branch mode", async () => {
		renderViewer();
		const block = await screen.findByTestId("pr-conversation-block");
		expect(within(block).getByText("1 unresolved")).toBeInTheDocument();
		expect(api.request.getTaskPrComments).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", force: false });

		const thread = await screen.findByTestId("github-thread");
		expect(within(thread).getByText("alice")).toBeInTheDocument();
		const markdown = within(thread).getByTestId("pr-comment-markdown");
		expect(markdown.querySelector("strong")?.textContent).toBe("this");
	});

	it("hides resolved threads until Show resolved is toggled", async () => {
		vi.mocked(api.request.getTaskPrComments).mockResolvedValue(makePrPayload({
			threads: [makeThread(), makeThread({ id: "th2", line: 2, isResolved: true })],
		}) as never);
		const user = userEvent.setup();
		renderViewer();

		await screen.findByTestId("github-thread");
		expect(screen.getAllByTestId("github-thread")).toHaveLength(1);

		await user.click(screen.getByTestId("pr-show-resolved-toggle"));
		await waitFor(() => {
			expect(screen.getAllByTestId("github-thread")).toHaveLength(2);
		});
	});

	it("collects outdated and off-diff threads into collapsed groups instead of dropping them", async () => {
		vi.mocked(api.request.getTaskPrComments).mockResolvedValue(makePrPayload({
			threads: [
				makeThread({ id: "th-outdated", isOutdated: true }),
				makeThread({ id: "th-gone", path: "gone/file.ts" }),
			],
		}) as never);
		const user = userEvent.setup();
		renderViewer();

		const outdatedGroup = await screen.findByTestId("github-outdated-group");
		expect(within(outdatedGroup).queryByTestId("github-thread")).not.toBeInTheDocument();
		await user.click(within(outdatedGroup).getByRole("button", { name: /Outdated review threads/ }));
		expect(within(outdatedGroup).getByTestId("github-thread")).toBeInTheDocument();

		const unmappedGroup = screen.getByTestId("pr-unmapped-group");
		await user.click(within(unmappedGroup).getByRole("button", { name: /Threads on files not in this diff/ }));
		expect(within(unmappedGroup).getByText("gone/file.ts")).toBeInTheDocument();
	});

	it("exports a selected GitHub thread into the XML with an origin marker", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		renderViewer();

		const thread = await screen.findByTestId("github-thread");
		expect(screen.queryByTestId("review-export-github-marker")).not.toBeInTheDocument();

		await user.click(within(thread).getByTestId("github-thread-export-toggle"));
		expect(screen.getByTestId("review-export-github-marker")).toHaveTextContent("alice");

		await user.click(screen.getByRole("button", { name: "Copy to Clipboard" }));
		const xml = writeText.mock.calls[writeText.mock.calls.length - 1][0] as string;
		expect(xml).toContain('<review origin="github" author="alice">');
		expect(xml).toContain('<file src="src/app.ts" line=1>');
		expect(xml).toContain("[alice] Rename **this** variable.");
		expect(xml).toContain("come from GitHub PR reviewers");
	});

	it("sends a thread to the agent as a fix prompt with file, snippet, and bodies", async () => {
		const user = userEvent.setup();
		renderViewer();

		const thread = await screen.findByTestId("github-thread");
		await user.click(within(thread).getByTestId("github-thread-send"));

		await waitFor(() => {
			expect(api.request.sendAgentMessageNow).toHaveBeenCalledTimes(1);
		});
		const { text, taskId } = vi.mocked(api.request.sendAgentMessageNow).mock.calls[0][0];
		expect(taskId).toBe("t1");
		expect(text).toContain("File: src/app.ts, line 1");
		expect(text).toContain('+const a = "two";');
		expect(text).toContain("[alice] wrote:");
		expect(text).toContain("Rename **this** variable.");
		expect(within(thread).getByText("Sent")).toBeInTheDocument();
	});

	it("shows the mode hint outside branch mode and switches on click", async () => {
		localStorage.setItem("dev3-inline-diff-mode-v1", "uncommitted");
		const user = userEvent.setup();
		renderViewer();

		const hint = await screen.findByTestId("pr-threads-mode-hint");
		expect(screen.queryByTestId("github-thread")).not.toBeInTheDocument();

		await user.click(within(hint).getByRole("button", { name: "Open Branch diff" }));
		await screen.findByTestId("github-thread");
		expect(screen.queryByTestId("pr-threads-mode-hint")).not.toBeInTheDocument();
	});

	it("surfaces fetch failures with a retry that refetches with force", async () => {
		vi.mocked(api.request.getTaskPrComments).mockRejectedValueOnce(new Error("gh exploded"));
		const user = userEvent.setup();
		renderViewer();

		const error = await screen.findByTestId("pr-comments-error");
		expect(error).toHaveTextContent("gh exploded");

		await user.click(within(error).getByRole("button", { name: "Retry" }));
		await screen.findByTestId("github-thread");
		expect(api.request.getTaskPrComments).toHaveBeenLastCalledWith({ taskId: "t1", projectId: "p1", force: true });
	});

	it("jumps to the first unresolved GitHub thread when opened with the deep-link flag", async () => {
		const scrolledThreadIds: string[] = [];
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: vi.fn(function (this: HTMLElement) {
				const threadId = this.getAttribute("data-thread-id");
				if (threadId) scrolledThreadIds.push(threadId);
			}),
		});
		vi.mocked(api.request.getTaskPrComments).mockResolvedValue(makePrPayload({
			threads: [makeThread({ id: "th-resolved", isResolved: true }), makeThread({ id: "th-live", line: 2 })],
		}) as never);
		render(
			<I18nProvider>
				<TaskDiffViewer
					task={prTask}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main", focusFirstUnresolvedThread: true }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findByTestId("github-thread");
		await waitFor(() => {
			expect(scrolledThreadIds).toContain("th-live");
		});
	});

	it("forces branch mode for the unresolved deep link even when another mode is preferred", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
		localStorage.setItem("dev3-inline-diff-mode-v1", "uncommitted");
		render(
			<I18nProvider>
				<TaskDiffViewer
					task={prTask}
					project={project}
					request={{ mode: "branch", compareRef: "origin/main", compareLabel: "origin/main", focusFirstUnresolvedThread: true }}
					onBack={vi.fn()}
				/>
			</I18nProvider>,
		);

		// The inline thread only renders in branch mode — the stored "uncommitted"
		// preference must not win over the deep link.
		await screen.findByTestId("github-thread");
		await waitFor(() => {
			expect(vi.mocked(api.request.getTaskDiff)).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: "branch" }),
			);
		});
	});
});
