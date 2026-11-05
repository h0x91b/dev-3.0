import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { TaskRefScopeContext, TaskRefText, splitTaskRefs } from "../TaskRefText";
import { CommentMarkdown } from "../pr-review/markdown";

const resolveTaskPrRef = vi.fn();
vi.mock("../../rpc", () => ({
	api: { request: { resolveTaskPrRef: (...args: unknown[]) => resolveTaskPrRef(...args) } },
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
