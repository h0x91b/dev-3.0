import { render, screen, waitFor } from "@testing-library/react";
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
