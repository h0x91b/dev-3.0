import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilePreviewModal from "../FilePreviewModal";
import { I18nProvider } from "../../i18n";
import { installImmediateIntersectionObserver } from "../../test-utils/immediate-intersection";
import type { FilePreviewResult } from "../../../shared/types";

const readFilePreview = vi.fn<(params: { path: string }) => Promise<FilePreviewResult>>();

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));

vi.mock("@streamdown/mermaid", () => ({
	createMermaidPlugin: () => ({
		name: "mermaid",
		type: "diagram",
		language: "mermaid",
		getMermaid: (config?: unknown) => {
			if (config) mermaid.initialize(config);
			return mermaid;
		},
	}),
}));

// isElectrobun=false — the browser/remote case, where host-side open actions
// must not render (they would act invisibly on the host machine).
vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			get readFilePreview() {
				return readFilePreview;
			},
			openTerminalPath: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

installImmediateIntersectionObserver();

function renderModal(path = "/wt/docs/guide.md", line?: number, onClose = vi.fn()) {
	return {
		onClose,
		...render(
			<I18nProvider>
				<FilePreviewModal path={path} line={line} onClose={onClose} />
			</I18nProvider>,
		),
	};
}

/** The find shortcut on a non-mac test environment (`isMac()` is false here). */
async function pressFind(user: ReturnType<typeof userEvent.setup>) {
	await user.keyboard("{Control>}f{/Control}");
}

describe("FilePreviewModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mermaid.render.mockResolvedValue({
			svg: '<svg data-testid="rendered-mermaid"></svg>',
			diagramType: "flowchart-v2",
		});
	});

	it("hides host-side open actions in browser mode but keeps copy actions", async () => {
		readFilePreview.mockResolvedValue({ kind: "text", content: "# Hi\n", truncated: false, size: 5 });
		renderModal();
		await waitFor(() => expect(screen.getByText("Copy content")).toBeInTheDocument());
		expect(screen.getByText("Copy path")).toBeInTheDocument();
		expect(screen.queryByText("Open folder")).not.toBeInTheDocument();
		expect(screen.queryByText("Open in default app")).not.toBeInTheDocument();
	});

	it("shows filename and directory as separate header lines", async () => {
		readFilePreview.mockResolvedValue({ kind: "text", content: "x", truncated: false, size: 1 });
		renderModal("/wt/docs/guide.md");
		expect(screen.getByRole("heading", { name: "guide.md" })).toBeInTheDocument();
		expect(screen.getByText("/wt/docs")).toBeInTheDocument();
	});

	it("renders markdown by default with a Raw toggle", async () => {
		readFilePreview.mockResolvedValue({
			kind: "text",
			content: "# Title\nbody",
			truncated: false,
			size: 12,
		});
		renderModal("/wt/docs/guide.md");
		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Title", level: 1 })).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rendered" })).toHaveAttribute("aria-pressed", "true");
	});

	it("renders a .mmd file as a Mermaid diagram, with the same Raw toggle", async () => {
		const user = userEvent.setup();
		readFilePreview.mockResolvedValue({
			kind: "text",
			content: "flowchart LR\nA --> B\n",
			truncated: false,
			size: 22,
		});
		renderModal("/wt/docs/chart.mmd");

		await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
		expect(mermaid.render).toHaveBeenCalledWith(
			expect.stringMatching(/^mermaid-/),
			"flowchart LR\nA --> B\n",
		);
		expect(screen.getByTestId("rendered-mermaid")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Raw" }));
		expect(screen.getByText("flowchart LR")).toBeInTheDocument();
		expect(screen.queryByTestId("rendered-mermaid")).not.toBeInTheDocument();
	});

	it("renders code with line numbers and highlights the target line", async () => {
		readFilePreview.mockResolvedValue({
			kind: "text",
			content: "one\ntwo\nthree",
			truncated: false,
			size: 13,
		});
		renderModal("/wt/src/a.ts", 2);
		await waitFor(() => expect(screen.getByText("two")).toBeInTheDocument());
		expect(screen.getByText("3")).toBeInTheDocument(); // gutter
		expect(screen.getByText("two").parentElement?.className).toContain("bg-accent/10");
		expect(screen.getByText("one").parentElement?.className).not.toContain("bg-accent/10");
		// No markdown toggle for non-markdown files.
		expect(screen.queryByRole("button", { name: "Raw" })).not.toBeInTheDocument();
	});

	describe("find in file (Cmd/Ctrl+F)", () => {
		it("opens the find bar, counts matches and steps through them", async () => {
			const user = userEvent.setup();
			readFilePreview.mockResolvedValue({
				kind: "text",
				content: "alpha\nbeta\nalpha",
				truncated: false,
				size: 16,
			});
			renderModal("/wt/src/a.ts");
			await waitFor(() => expect(screen.getByText("beta")).toBeInTheDocument());
			expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();

			await pressFind(user);
			const input = await screen.findByRole("textbox", { name: "Find in file" });
			expect(input).toHaveFocus();

			await user.type(input, "alpha");
			await waitFor(() => expect(screen.getByTestId("find-bar-count")).toHaveTextContent("1/2"));

			await user.keyboard("{Enter}");
			expect(screen.getByTestId("find-bar-count")).toHaveTextContent("2/2");
			// Wraps back to the first match rather than stopping at the end.
			await user.keyboard("{Enter}");
			expect(screen.getByTestId("find-bar-count")).toHaveTextContent("1/2");

			await user.keyboard("{Shift>}{Enter}{/Shift}");
			expect(screen.getByTestId("find-bar-count")).toHaveTextContent("2/2");
		});

		it("finds text inside rendered markdown, not only the raw source", async () => {
			const user = userEvent.setup();
			readFilePreview.mockResolvedValue({
				kind: "text",
				content: "# Title\n\nsome **needle** in prose",
				truncated: false,
				size: 30,
			});
			renderModal("/wt/docs/guide.md");
			await waitFor(() =>
				expect(screen.getByRole("heading", { name: "Title", level: 1 })).toBeInTheDocument(),
			);

			await pressFind(user);
			await user.type(await screen.findByRole("textbox", { name: "Find in file" }), "needle");
			await waitFor(() => expect(screen.getByTestId("find-bar-count")).toHaveTextContent("1/1"));
		});

		it("reports zero matches instead of hiding the counter", async () => {
			const user = userEvent.setup();
			readFilePreview.mockResolvedValue({ kind: "text", content: "alpha", truncated: false, size: 5 });
			renderModal("/wt/src/a.ts");
			await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

			await pressFind(user);
			await user.type(await screen.findByRole("textbox", { name: "Find in file" }), "zzz");
			await waitFor(() => expect(screen.getByTestId("find-bar-count")).toHaveTextContent("0/0"));
		});

		it("closes the find bar on Escape and the modal only on the next one", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			readFilePreview.mockResolvedValue({ kind: "text", content: "alpha", truncated: false, size: 5 });
			renderModal("/wt/src/a.ts", undefined, onClose);
			await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

			await pressFind(user);
			await screen.findByTestId("find-bar");
			await user.keyboard("{Escape}");
			expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();

			await user.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes the find bar from its own close button", async () => {
			const user = userEvent.setup();
			readFilePreview.mockResolvedValue({ kind: "text", content: "alpha", truncated: false, size: 5 });
			renderModal("/wt/src/a.ts");
			await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

			await pressFind(user);
			await user.click(await screen.findByTestId("find-bar-close"));
			expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
		});

		// The board's own ⌘F handlers listen on the window and would otherwise steal
		// the key behind the modal — that was the whole reported bug.
		it("keeps the shortcut from reaching window-level find handlers", async () => {
			const user = userEvent.setup();
			const seenCodes: string[] = [];
			const boardFind = (event: KeyboardEvent) => seenCodes.push(event.code);
			window.addEventListener("keydown", boardFind);
			try {
				readFilePreview.mockResolvedValue({ kind: "text", content: "alpha", truncated: false, size: 5 });
				renderModal("/wt/src/a.ts");
				await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

				await pressFind(user);
				await screen.findByTestId("find-bar");
				// The bare Control keydown still passes through; the ⌘/Ctrl+F one must not.
				expect(seenCodes).not.toContain("KeyF");
			} finally {
				window.removeEventListener("keydown", boardFind);
			}
		});
	});

	it("shows the not-found state without any open actions", async () => {
		readFilePreview.mockResolvedValue({ kind: "not-found" });
		renderModal("/nope/missing.txt");
		await waitFor(() =>
			expect(screen.getByText(/File not found/)).toBeInTheDocument(),
		);
		expect(screen.queryByText("Copy content")).not.toBeInTheDocument();
		expect(screen.queryByText("Open folder")).not.toBeInTheDocument();
	});
});

describe("FilePreviewModal review comments", () => {
	const reviewApi = () => (api.request as unknown as Record<string, ReturnType<typeof vi.fn>>);

	beforeEach(() => {
		for (const name of ["addReviewComment", "updateReviewComment", "deleteReviewComment", "markReviewCommentsSent", "reopenReviewComment", "sendAgentMessageNow"]) {
			reviewApi()[name] = vi.fn().mockResolvedValue({ spilledPath: null });
		}
		readFilePreview.mockResolvedValue({ kind: "text", content: "one\ntwo\nthree", truncated: false, size: 13 });
	});

	function selectLines(from: HTMLElement, to: HTMLElement, text: string) {
		const range = document.createRange();
		range.setStart(from.firstChild ?? from, 0);
		range.setEnd(to.firstChild ?? to, (to.textContent ?? "").length);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		selection.toString = () => text;
		range.getBoundingClientRect = () => ({ left: 40, top: 20, bottom: 50, right: 200, width: 160, height: 30, x: 40, y: 20, toJSON: () => ({}) }) as DOMRect;
	}

	it("offers a comment on a text selection and stores it with the path, line range and excerpt", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<FilePreviewModal path="/wt/src/a.ts" taskId="t1" projectId="p1" task={{ id: "t1" }} onClose={vi.fn()} />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByText("two")).toBeInTheDocument());
		expect(screen.queryByTestId("file-review")).not.toBeInTheDocument();

		selectLines(screen.getByText("two"), screen.getByText("three"), "two\nthree");
		const body = screen.getByText("two").closest("[data-preview-line]")!.parentElement!.parentElement as HTMLElement;
		fireEvent.mouseUp(body);
		const button = await screen.findByTestId("file-preview-comment-selection");
		await user.click(button);

		const composer = await screen.findByTestId("file-review-composer");
		expect(composer).toHaveTextContent("a.ts:2–3 · two");
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Rename these");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(reviewApi().addReviewComment).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "t1",
			projectId: "p1",
			comment: expect.objectContaining({
				body: "Rename these",
				anchor: { kind: "file-range", path: "/wt/src/a.ts", startLine: 2, endLine: 3, excerpt: "two\nthree" },
			}),
		}));
		expect(screen.getByTestId("file-review-thread")).toHaveTextContent("Rename these");
		expect(screen.getByText("two").parentElement).toHaveAttribute("data-commented", "true");
		expect(screen.getByText("one").parentElement).not.toHaveAttribute("data-commented");
	});

	it("shows no selection button without a project", async () => {
		render(<I18nProvider><FilePreviewModal path="/wt/src/a.ts" taskId="t1" onClose={vi.fn()} /></I18nProvider>);
		await waitFor(() => expect(screen.getByText("two")).toBeInTheDocument());
		selectLines(screen.getByText("two"), screen.getByText("two"), "two");
		fireEvent.mouseUp(screen.getByText("two"));
		expect(screen.queryByTestId("file-preview-comment-selection")).not.toBeInTheDocument();
	});
});

describe("FilePreviewModal image review", () => {
	it("lets a click on a previewed image become a region comment anchored by the file path", async () => {
		const reviewApi = api.request as unknown as Record<string, ReturnType<typeof vi.fn>>;
		for (const name of ["addReviewComment", "markReviewCommentsSent", "sendAgentMessageNow"]) reviewApi[name] = vi.fn().mockResolvedValue({ spilledPath: null });
		readFilePreview.mockResolvedValue({ kind: "image", dataUrl: "data:image/png;base64,AAAA", size: 10 } as FilePreviewResult);
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<FilePreviewModal path="/wt/shots/after.png" taskId="t1" projectId="p1" task={{ id: "t1" }} onClose={vi.fn()} />
			</I18nProvider>,
		);
		const img = await screen.findByAltText("after.png");
		Object.defineProperty(img, "clientWidth", { value: 400, configurable: true });
		Object.defineProperty(img, "clientHeight", { value: 200, configurable: true });
		fireEvent.load(img);
		const overlay = await screen.findByTestId("file-image-review-overlay");
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		fireEvent.pointerDown(overlay, { button: 0, clientX: 200, clientY: 100, pointerId: 1 });
		fireEvent.pointerUp(overlay, { clientX: 200, clientY: 100, pointerId: 1 });
		expect(await screen.findByTestId("file-review-composer")).toHaveTextContent("after.png · x 47%–53%, y 47%–53%");
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Cut off here");
		await user.click(screen.getByRole("button", { name: "Add comment" }));
		expect(reviewApi.addReviewComment).toHaveBeenCalledWith(expect.objectContaining({
			comment: expect.objectContaining({
				anchor: expect.objectContaining({ kind: "image-region", imageId: "/wt/shots/after.png", path: "/wt/shots/after.png", name: "after.png" }),
			}),
		}));
		expect(screen.getByTestId("file-image-review-region")).toBeInTheDocument();
	});
});
