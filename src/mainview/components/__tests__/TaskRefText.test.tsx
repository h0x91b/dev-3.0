import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { TaskRefScopeContext, TaskRefText, splitTaskRefs } from "../TaskRefText";
import { CommentMarkdown } from "../pr-review/markdown";
import { clearTaskPrRefPreviewCache } from "../../task-ref-preview";

const resolveTaskPrRef = vi.fn();
const previewTaskPrRef = vi.fn();
vi.mock("../../rpc", () => ({
	api: { request: {
		resolveTaskPrRef: (...args: unknown[]) => resolveTaskPrRef(...args),
		previewTaskPrRef: (...args: unknown[]) => previewTaskPrRef(...args),
		readImageBase64: () => new Promise(() => {}),
	} },
	isElectrobun: false,
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const wrap = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

describe("splitTaskRefs", () => {
	it("keeps the prose and cuts out each reference", () => {
		const parts = splitTaskRefs("ask <seq:12> about <pr:7>.");
		expect(parts).toEqual([
			"ask ",
			{ ref: { kind: "task", number: 12 }, key: 4 },
			" about ",
			{ ref: { kind: "pr", number: 7 }, key: 19 },
			".",
		]);
	});
});

describe("TaskRefText", () => {
	beforeEach(() => {
		resolveTaskPrRef.mockReset();
	});

	it("leaves text without references untouched", () => {
		const { container } = wrap(<TaskRefText text="nothing #115 here" />);
		expect(container.textContent).toBe("nothing #115 here");
		expect(container.querySelector("button")).toBeNull();
	});

	it("opens a task on its own board, resolving a bare ref on the text's project", async () => {
		resolveTaskPrRef.mockResolvedValue({ kind: "task", taskId: "t-9", projectId: "p-2", projectName: "x", seq: 9, title: "T", status: "todo" });
		const opened = vi.fn();
		window.addEventListener("rpc:openDeepLink", opened as EventListener);
		wrap(<TaskRefText text="see <seq:9>" contextProjectId="p-1" />);
		fireEvent.click(screen.getByRole("button", { name: /<seq:9>/ }));
		await waitFor(() => expect(opened).toHaveBeenCalled());
		expect(resolveTaskPrRef).toHaveBeenCalledWith({ ref: "seq:9", contextProjectId: "p-1" });
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: "task", taskId: "t-9", projectId: "p-2" });
		window.removeEventListener("rpc:openDeepLink", opened as EventListener);
	});

	it("opens a PR on GitHub", async () => {
		resolveTaskPrRef.mockResolvedValue({ kind: "pr", number: 7, projectId: "p-1", projectName: "x", url: "https://github.com/o/r/pull/7" });
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		wrap(<TaskRefText text="<pr:7> merged" contextProjectId="p-1" />);
		fireEvent.click(screen.getByRole("button", { name: /<pr:7>/ }));
		await waitFor(() => expect(open).toHaveBeenCalledWith("https://github.com/o/r/pull/7", "_blank", "noopener,noreferrer"));
		open.mockRestore();
	});
});

describe("references inside markdown", () => {
	it("survives the sanitizer as a link and resolves on the scope's project", async () => {
		resolveTaskPrRef.mockResolvedValue(null);
		const { container } = wrap(
			<TaskRefScopeContext.Provider value={{ projectId: "p-5" }}>
				<CommentMarkdown body={"done in <seq:115> and [the PR](pr:a1c9fe4e/7)"} />
			</TaskRefScopeContext.Provider>,
		);
		expect(container.textContent).not.toContain("[blocked]");
		const links = container.querySelectorAll("[data-task-ref]");
		expect([...links].map((l) => l.getAttribute("data-task-ref"))).toEqual(["seq:115", "pr:a1c9fe4e/7"]);
		expect(links[1].textContent).toBe("the PR");
		fireEvent.click(links[0]);
		await waitFor(() => expect(resolveTaskPrRef).toHaveBeenCalledWith({ ref: "seq:115", contextProjectId: "p-5" }));
	});

	it("does not turn a reference scheme into an image source", () => {
		const { container } = wrap(<CommentMarkdown body={"![x](seq:1)"} />);
		expect(container.querySelector("img[src^='seq:']")).toBeNull();
	});
});

describe("hover previews", () => {
	beforeEach(() => {
		previewTaskPrRef.mockReset();
		clearTaskPrRefPreviewCache();
	});

	it("previews a task on hover: title, status, overview, notes and artifacts", async () => {
		previewTaskPrRef.mockResolvedValue({
			kind: "task",
			target: { kind: "task", taskId: "t-9", projectId: "p-1", projectName: "x", seq: 9, title: "Fix auth race", status: "in-progress" },
			task: { id: "t-9", seq: 9, status: "in-progress", priority: "P1", agentId: null, prNumber: 31, prUrl: "https://github.com/o/r/pull/31" },
			labels: [{ id: "l1", name: "frontend", color: "#ef4444" }],
			customColumn: null,
			overview: "Lock landed, verifying.",
			notes: [{ id: "n1", content: "Root cause is the token refresh, see <seq:5>.", createdAt: "" }],
			images: [],
			imageCount: 0,
			artifacts: [{ id: "a1", title: "Race report" }],
			artifactCount: 3,
		});
		wrap(<TaskRefText text="see <seq:9>" contextProjectId="p-1" />);
		fireEvent.mouseEnter(screen.getByRole("button", { name: /<seq:9>/ }).parentElement!);
		const card = await screen.findByTestId("task-ref-preview");
		expect(previewTaskPrRef).toHaveBeenCalledWith({ ref: "seq:9", contextProjectId: "p-1" });
		expect(card.textContent).toContain("Fix auth race");
		// Dressed as its kanban card: priority, #seq, the read-only rail, labels, PR badge.
		expect(card.textContent).toContain("P1");
		expect(card.textContent).toContain("#9");
		expect(card.querySelector("[data-testid='task-card-rail'] button")).toBeNull();
		expect(card.textContent).toContain("frontend");
		expect(card.textContent).toContain("#31");
		expect(card.textContent).toContain("Lock landed, verifying.");
		expect(card.textContent).toContain("Root cause is the token refresh, see seq:5.");
		// A ref inside the card is a plain link: a nested card would close this one on the way in.
		const nested = card.querySelector("[data-task-ref='seq:5']")!;
		expect(nested.tagName).toBe("BUTTON");
		expect(nested.parentElement?.tagName).toBe("LI");
		expect(card.textContent).toContain("Race report");
		expect(card.textContent).toContain("+2 more");
		// Same project as the text: no project line to repeat it.
		expect(screen.queryByText("x")).toBeNull();
		const opened = vi.fn();
		window.addEventListener("rpc:openDeepLink", opened as EventListener);
		fireEvent.click(screen.getByTestId("task-ref-preview-open"));
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: "task", taskId: "t-9", projectId: "p-1" });
		window.removeEventListener("rpc:openDeepLink", opened as EventListener);
	});

	it("gives a coordinator's preview the board's role band", async () => {
		previewTaskPrRef.mockResolvedValue({
			kind: "task",
			target: { kind: "task", taskId: "t-c", projectId: "p-1", projectName: "x", seq: 12, title: "Coordinate", status: "in-progress" },
			task: { id: "t-c", seq: 12, status: "in-progress", taskType: "coordinator", agentId: null },
			labels: [], customColumn: null, overview: null, notes: [], images: [], imageCount: 0, artifacts: [], artifactCount: 0,
		});
		wrap(<TaskRefText text="ask <seq:12>" contextProjectId="p-1" />);
		fireEvent.mouseEnter(screen.getByRole("button", { name: /<seq:12>/ }).parentElement!);
		const card = await screen.findByTestId("task-ref-preview");
		expect(card.querySelector("[data-testid='task-role-band'][data-role='coordinator']")).not.toBeNull();
	});

	it("says so when the reference resolves to nothing", async () => {
		previewTaskPrRef.mockResolvedValue(null);
		wrap(<TaskRefText text="<seq:404>" contextProjectId="p-1" />);
		fireEvent.mouseEnter(screen.getByRole("button", { name: /<seq:404>/ }).parentElement!);
		expect(await screen.findByText("No such task or PR on that board.")).toBeTruthy();
	});

	it("opens the PR status popover on hover and loads it lazily", async () => {
		previewTaskPrRef.mockResolvedValue({
			kind: "pr",
			target: { kind: "pr", number: 7, projectId: "p-1", projectName: "x", url: "https://github.com/o/r/pull/7" },
			badge: { number: 7, url: "https://github.com/o/r/pull/7", prTitle: "Add the lock", ciStatus: "success", mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" }, checks: [] },
		});
		wrap(<TaskRefText text="<pr:7> is up" contextProjectId="p-1" />);
		expect(previewTaskPrRef).not.toHaveBeenCalled();
		fireEvent.mouseEnter(screen.getByRole("button", { name: /<pr:7>/ }).closest("span")!);
		const popover = await screen.findByTestId("pr-status-popover");
		await waitFor(() => expect(popover.textContent).toContain("Add the lock"));
		expect(previewTaskPrRef).toHaveBeenCalledWith({ ref: "pr:7", contextProjectId: "p-1" });
	});
});

describe("PrRefSummary", () => {
	it("opens the PR on GitHub in a new tab", async () => {
		const { PrRefSummary } = await import("../TaskRefPreviewCard");
		wrap(<PrRefSummary preview={{
			kind: "pr",
			target: { kind: "pr", number: 2191, projectId: "p-1", projectName: "x", url: "https://github.com/o/r/pull/2191" },
			badge: { number: 2191, url: "https://github.com/o/r/pull/2191", prTitle: "Run cleanup", mergeState: { mergeable: null, status: null, state: "MERGED" }, ciStatus: "success" },
		}} />);
		const open = screen.getByTestId("pr-ref-summary-open");
		expect(open.getAttribute("href")).toBe("https://github.com/o/r/pull/2191");
		expect(open.getAttribute("target")).toBe("_blank");
		expect(open.getAttribute("rel")).toContain("noopener");
	});
});
