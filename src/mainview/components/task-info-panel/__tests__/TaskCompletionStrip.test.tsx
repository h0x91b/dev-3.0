import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, UnsavedWork } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";

vi.mock("../../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn() } } }));

import { api } from "../../../rpc";
import { _resetCompletionOffersForTests, isCompletionStripMounted, offerCompletion, type CompletionOfferAnswer } from "../../../completion-offers";
import TaskCompletionStrip, { COMPLETION_STRIP_ARM_MS } from "../TaskCompletionStrip";
import { clearanceNodes } from "../../../toast-clearance";

const project = { id: "p1", name: "Alpha", path: "/a" } as Project;
const worktreeTask = { id: "t1", projectId: "p1", worktreePath: "/wt/t1", branchName: "feat/x", status: "review-by-user" } as Task;
const folderTask = { ...worktreeTask, worktreePath: null } as unknown as Task;
const clean: UnsavedWork = { insertions: 0, deletions: 0, unpushed: 0, ahead: 0 } as UnsavedWork;

function renderStrip(task: Task = worktreeTask) {
	return render(<I18nProvider><TaskCompletionStrip task={task} project={project} /></I18nProvider>);
}

async function offer(kind: "merge" | "agent"): Promise<{ answer: Promise<CompletionOfferAnswer | null> }> {
	let answer!: Promise<CompletionOfferAnswer | null>;
	await act(async () => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind, branchName: "feat/x" }); });
	return { answer };
}

async function arm() {
	await act(async () => { vi.advanceTimersByTime(COMPLETION_STRIP_ARM_MS + 1); });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(api.request.getUnsavedWork).mockResolvedValue(clean);
});
afterEach(() => {
	_resetCompletionOffersForTests();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("TaskCompletionStrip", () => {
	it("renders nothing without an offer", () => {
		const { container } = renderStrip();
		expect(container).toBeEmptyDOMElement();
	});

	it("is inline, not a dialog, and never takes focus", async () => {
		renderStrip();
		const before = document.activeElement;
		await offer("agent");
		expect(screen.getByTestId("task-completion-strip")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(before);
	});

	it("ignores a click that lands before the strip arms", async () => {
		renderStrip();
		const { answer } = await offer("merge");
		await act(async () => {});
		fireEvent.click(screen.getByTestId("task-completion-strip-complete"));
		expect(screen.getByTestId("task-completion-strip")).toBeInTheDocument();
		await arm();
		fireEvent.click(screen.getByTestId("task-completion-strip-complete"));
		await expect(answer).resolves.toBe(true);
	});

	it("gates Complete until the unsaved-work check settles, then shows what would be lost", async () => {
		let release!: (w: UnsavedWork) => void;
		vi.mocked(api.request.getUnsavedWork).mockReturnValue(new Promise((r) => { release = r; }) as never);
		renderStrip();
		await offer("agent");
		await arm();
		expect(screen.getByTestId("task-completion-strip-complete")).toBeDisabled();
		await act(async () => release({ ...clean, insertions: 3, deletions: 1 }));
		expect(screen.getByTestId("task-completion-strip-complete")).toBeEnabled();
		expect(screen.getByTestId("task-completion-strip-warning")).toHaveTextContent("3");
	});

	it("skips the git check for a task without a worktree and says the session ends", async () => {
		renderStrip(folderTask);
		await offer("agent");
		expect(api.request.getUnsavedWork).not.toHaveBeenCalled();
		expect(screen.getByText("Completing ends the terminal session.")).toBeInTheDocument();
		expect(screen.getByTestId("task-completion-strip-complete")).toBeEnabled();
	});

	it("says the folder is kept when the project's git workflow is off", async () => {
		render(<I18nProvider><TaskCompletionStrip task={worktreeTask} project={{ ...project, gitWorkflow: false } as Project} /></I18nProvider>);
		await offer("agent");
		expect(screen.getByText("Completing ends the terminal session. The working folder and its files are kept.")).toBeInTheDocument();
		expect(screen.queryByText("Completing removes the worktree and ends the terminal session.")).toBeNull();
	});

	it("says the worktree goes for an own-worktree task in a workflow-off project", async () => {
		render(<I18nProvider><TaskCompletionStrip task={{ ...worktreeTask, ownWorktree: true } as Task} project={{ ...project, gitWorkflow: false } as Project} /></I18nProvider>);
		await offer("agent");
		expect(screen.getByText("Completing removes the worktree and ends the terminal session.")).toBeInTheDocument();
	});

	it("lets Complete through when the check fails, with a warning", async () => {
		vi.mocked(api.request.getUnsavedWork).mockRejectedValue(new Error("git gone"));
		renderStrip();
		await offer("merge");
		await act(async () => {});
		expect(screen.getByText("Could not check the branch for unsaved work.")).toBeInTheDocument();
		expect(screen.getByTestId("task-completion-strip-complete")).toBeEnabled();
	});

	it("offers the manual opt-out and the settings link for merges only", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openSettingsSection", spy);
		renderStrip();
		const { answer } = await offer("merge");
		await arm();
		fireEvent.click(screen.getByRole("button", { name: "Settings for completion offers after a merge" }));
		expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "tasks", anchor: "suggest-completing-after-merge" });
		window.removeEventListener("dev3:openSettingsSection", spy);
		fireEvent.click(screen.getByRole("button", { name: "I’ll complete it myself" }));
		await expect(answer).resolves.toBe("manual");
	});

	it("re-checks on Complete and holds when new unsaved work appeared", async () => {
		renderStrip();
		const { answer } = await offer("merge");
		await arm();
		vi.mocked(api.request.getUnsavedWork).mockResolvedValue({ ...clean, insertions: 2, deletions: 0 });
		await act(async () => { fireEvent.click(screen.getByTestId("task-completion-strip-complete")); });
		expect(screen.getByTestId("task-completion-strip-warning")).toHaveTextContent("2");
		expect(screen.getByTestId("task-completion-strip")).toBeInTheDocument();
		await act(async () => { fireEvent.click(screen.getByTestId("task-completion-strip-complete")); });
		await expect(answer).resolves.toBe(true);
	});

	it("registers itself so callers know the offer is on screen", async () => {
		const { unmount } = renderStrip();
		expect(isCompletionStripMounted("t1")).toBe(true);
		unmount();
		expect(isCompletionStripMounted("t1")).toBe(false);
	});

	it("floats over a live terminal and the inline row stands down, so nothing resizes", async () => {
		render(
			<I18nProvider>
				<TaskCompletionStrip task={worktreeTask} project={project} />
				<div data-testid="viewport"><TaskCompletionStrip task={worktreeTask} project={project} variant="overlay" /></div>
			</I18nProvider>,
		);
		await offer("merge");
		const strips = screen.getAllByTestId("task-completion-strip");
		expect(strips).toHaveLength(1);
		expect(screen.getByTestId("viewport")).toContainElement(strips[0]!);
		expect(strips[0]!.className).toContain("absolute");
	});

	it("drops below the tmux ZOOMED badge, which holds the same corner", async () => {
		render(
			<I18nProvider>
				<TaskCompletionStrip task={worktreeTask} project={project} variant="overlay" belowZoomBadge />
			</I18nProvider>,
		);
		await offer("merge");
		const strip = screen.getByTestId("task-completion-strip");
		expect(strip.className).toContain("top-11");
		expect(strip.className).not.toContain("top-2");
	});

	it("keeps toasts below it, so a toast never covers its buttons", async () => {
		renderStrip();
		await offer("merge");
		expect(clearanceNodes.has(screen.getByTestId("task-completion-strip"))).toBe(true);
	});

	it("falls back to the inline row when no terminal hosts the overlay", async () => {
		renderStrip();
		await offer("merge");
		expect(screen.getByTestId("task-completion-strip").className).not.toContain("absolute");
	});

	it("answers an agent request with Keep open as a decline", async () => {
		renderStrip();
		const { answer } = await offer("agent");
		await arm();
		expect(screen.queryByRole("button", { name: "I’ll complete it myself" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
		await expect(answer).resolves.toBe(false);
	});
});
