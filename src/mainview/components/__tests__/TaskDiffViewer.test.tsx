import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Task, TaskDiffResponse } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskDiffViewer from "../TaskDiffViewer";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskDiff: vi.fn(),
			getGlobalSettings: vi.fn(),
		},
	},
}));

vi.mock("@git-diff-view/react", async () => {
	const React = await import("react");
	const SplitSide = {
		old: 0,
		new: 1,
	} as const;

	return {
		DiffView: ({
			diffViewMode,
			diffViewTheme,
			diffViewAddWidget,
			renderWidgetLine,
			renderExtendLine,
			extendData,
		}: {
			diffViewMode: number;
			diffViewTheme: "dark" | "light";
			diffViewAddWidget?: boolean;
			renderWidgetLine?: (props: { lineNumber: number; side: number; onClose: () => void; diffFile: object }) => React.ReactNode;
			renderExtendLine?: (props: { lineNumber: number; side: number; data: unknown; onUpdate: () => void; diffFile: object }) => React.ReactNode;
			extendData?: {
				oldFile?: Record<string, { data: unknown }>;
				newFile?: Record<string, { data: unknown }>;
			};
		}) => {
			const [widget, setWidget] = React.useState<{ lineNumber: number; side: number } | null>(null);
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
				<div data-testid="mock-diff">
					mode:{diffViewMode} theme:{diffViewTheme}
					{diffViewAddWidget && (
						<button
							type="button"
							aria-label="Open inline comment composer"
							onClick={() => setWidget({ lineNumber: 2, side: SplitSide.new })}
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
			);
		},
		DiffModeEnum: {
			Split: 3,
			Unified: 4,
		},
		SplitSide,
		DiffFile: class {
			initTheme() {}
			initRaw() {}
			buildSplitDiffLines() {}
			buildUnifiedDiffLines() {}
		},
	};
});

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
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
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

	it("adds inline comments through the diff widget and renders them under the line", async () => {
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

		const diffs = await screen.findAllByTestId("mock-diff");
		await user.click(within(diffs[0]).getByRole("button", { name: "Open inline comment composer" }));
		expect(screen.getByTestId("mock-widget").querySelector(".dev3-inline-comment--composer")).not.toBeNull();

		await user.type(
			screen.getByPlaceholderText("Leave a comment on this line..."),
			"Watch this branch edge case.",
		);
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(screen.queryByPlaceholderText("Leave a comment on this line...")).not.toBeInTheDocument();
		expect(screen.getByText("Watch this branch edge case.")).toBeInTheDocument();
		expect(screen.getByText("New line 2")).toBeInTheDocument();
		expect(document.querySelector(".dev3-inline-comment--thread")).not.toBeNull();

		const reviewExport = screen.getByTestId("review-export-xml") as HTMLTextAreaElement;
		expect(reviewExport.value).toBe([
			"<reviews>",
			"<review>",
			"<file src=\"src/app.ts\" line=2>",
			"-const a = 1;",
			"+const a = 2;",
			"+const b = 3;",
			"</file>",
			"<comment>Watch this branch edge case.</comment>",
			"</review>",
			"</reviews>",
		].join("\n"));

		await user.click(screen.getByRole("button", { name: "Copy to Clipboard" }));
		expect(writeText).toHaveBeenCalledWith(reviewExport.value);
		expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
	});
});
