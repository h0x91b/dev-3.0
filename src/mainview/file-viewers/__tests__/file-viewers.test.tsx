import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Fiber } from "cordis";
import FilePreviewModal from "../../components/FilePreviewModal";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { resetPluginsForTests } from "../../plugins/runtime";
import type { FilePreviewResult } from "../../../shared/types";
import { getFileViewerRegistry, type FileViewerItem, type FileViewerProps } from "../registry";
import { installFileViewerBuiltins } from "./install-builtins";

const readFilePreview = vi.fn<(params: { path: string }) => Promise<FilePreviewResult>>();

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			get readFilePreview() {
				return readFilePreview;
			},
			getFileMediaUrl: vi.fn(),
			openTerminalPath: vi.fn(),
			createFileLink: vi.fn(),
			openFileOnWindowsHost: vi.fn(),
			addReviewComment: vi.fn().mockResolvedValue({ spilledPath: null }),
		},
	},
}));
vi.mock("../../file-open-browser", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../file-open-browser")>()),
	windowsHostOpenAvailable: vi.fn(async () => false),
}));

import { api } from "../../rpc";

const CSV: FilePreviewResult = { kind: "text", content: "a,b\n1,2\n3,4", truncated: false, size: 11 };

function openPreview(path = "/wt/data.csv", review = false) {
	return render(
		<I18nProvider>
			<FilePreviewModal path={path} onClose={vi.fn()} {...(review ? { taskId: "t1", projectId: "p1", task: { id: "t1" } } : {})} />
		</I18nProvider>,
	);
}

/** A table viewer that keeps the host's line marks, so a selection still anchors to lines. */
function CsvTable({ preview, commentedLines }: FileViewerProps) {
	if (preview.kind !== "text") return null;
	return (
		<table data-testid="csv-table">
			<tbody>
				{preview.content.split("\n").map((row, i) => (
					<tr key={i} data-preview-line={i + 1} data-commented={commentedLines.has(i + 1) ? "true" : undefined}>
						{row.split(",").map((cell, j) => <td key={j}>{cell}</td>)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

const csvViewer = (extra: Partial<FileViewerItem> = {}): FileViewerItem => ({
	id: "acme:csv",
	order: 5,
	matches: ({ preview, path }) => preview.kind === "text" && path.endsWith(".csv"),
	component: CsvTable,
	...extra,
});

async function contribute(item: FileViewerItem, name = "acme"): Promise<Fiber> {
	const fiber = getAppRoot().plugin({ name, inject: ["fileViewers"], apply: (ctx) => void ctx.fileViewers.register(item) });
	await act(async () => {});
	return fiber;
}

const viewerLogs = () => errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes("file viewer") || line.includes("fileViewers"));

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
	await installFileViewerBuiltins();
	readFilePreview.mockResolvedValue(CSV);
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("fileViewers slot", () => {
	it("is a contribution slot with dev3's viewers in match order", () => {
		const registry = getFileViewerRegistry();
		expect(registry.kind).toBe("contribute");
		expect(registry.list().map(({ def }) => def.id)).toEqual(["builtin:markdown", "builtin:code", "builtin:image", "builtin:media", "builtin:notice"]);
	});

	it("draws the first matching viewer by order, inside the host's text frame", async () => {
		await contribute(csvViewer());
		await contribute({ ...csvViewer(), id: "acme:late", order: 99, component: () => <p>late</p> }, "late");
		openPreview();
		expect(await screen.findByTestId("csv-table")).toBeInTheDocument();
		expect(screen.queryByTestId("file-preview-code")).toBeNull();
		expect(screen.queryByText("late")).toBeNull();
		// A file it does not match still gets dev3's code view.
		readFilePreview.mockResolvedValue({ kind: "text", content: "x = 1", truncated: false, size: 5 });
		openPreview("/wt/a.py");
		expect(await screen.findByTestId("file-preview-code")).toBeInTheDocument();
	});

	it("keeps comment anchoring in the host: a selection over a viewer's marked lines becomes a file-range comment", async () => {
		await contribute(csvViewer());
		const user = userEvent.setup();
		openPreview("/wt/data.csv", true);
		const table = within(await screen.findByTestId("csv-table"));
		const from = table.getByText("1");
		const to = table.getByText("4");
		const range = document.createRange();
		range.setStart(from.firstChild!, 0);
		range.setEnd(to.firstChild!, 1);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		selection.toString = () => "1,2\n3,4";
		range.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 10, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		fireEvent.mouseUp(screen.getByTestId("csv-table"));
		await user.click(await screen.findByTestId("file-preview-comment-selection"));
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Check totals");
		await user.click(screen.getByRole("button", { name: "Add comment" }));
		expect(api.request.addReviewComment).toHaveBeenCalledWith(expect.objectContaining({
			comment: expect.objectContaining({ anchor: { kind: "file-range", path: "/wt/data.csv", startLine: 2, endLine: 3, excerpt: "1,2\n3,4" } }),
		}));
		await waitFor(() => expect(table.getByText("1").closest("tr")).toHaveAttribute("data-commented", "true"));
		expect(table.getByText("a").closest("tr")).not.toHaveAttribute("data-commented");
	});

	it("skips a throwing matcher and logs it once per viewer", async () => {
		await contribute(csvViewer({ matches: () => { throw new Error("match boom"); } }));
		const user = userEvent.setup();
		readFilePreview.mockResolvedValue({ kind: "text", content: "# Title", truncated: false, size: 7 });
		openPreview("/wt/README.md");
		expect(await screen.findByRole("heading", { name: "Title" })).toBeInTheDocument();
		// The Raw toggle matches again: the source view, and no second log.
		await user.click(screen.getByRole("button", { name: "Raw" }));
		expect(await screen.findByTestId("file-preview-code")).toBeInTheDocument();
		expect(viewerLogs()).toEqual(["[fileViewers] matches of file viewer acme:csv threw; skipping it:"]);
	});

	it("falls back to the built-in for the same file under a notice when a viewer crashes", async () => {
		await contribute(csvViewer({ component: () => { throw new Error("render boom"); } }));
		openPreview();
		expect(await screen.findByRole("alert")).toHaveTextContent("This file viewer crashed, so the built-in preview is shown instead.");
		expect(screen.getByTestId("file-preview-code")).toHaveTextContent("1,2");
		expect(viewerLogs().some((line: string) => line.includes("fileViewers item acme:csv crashed"))).toBe(true);
	});

	it("shows only the notice when the built-in itself crashes", async () => {
		await contribute({ id: "builtin:broken", order: 1, matches: () => true, component: () => { throw new Error("render boom"); } }, "broken");
		openPreview();
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByTestId("file-preview-code")).toBeNull();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("draws the built-ins before they have registered", async () => {
		resetPluginsForTests();
		openPreview();
		expect(await screen.findByTestId("file-preview-code")).toHaveTextContent("3,4");
	});

	it("[dispose] puts dev3's viewer back in the open preview when the plugin unloads", async () => {
		const fiber = await contribute(csvViewer());
		openPreview();
		await screen.findByTestId("csv-table");
		await act(async () => {
			await fiber.dispose();
		});
		expect(getFileViewerRegistry().get("acme:csv")).toBeUndefined();
		expect(screen.queryByTestId("csv-table")).toBeNull();
		expect(screen.getByTestId("file-preview-code")).toHaveTextContent("1,2");
	});
});
