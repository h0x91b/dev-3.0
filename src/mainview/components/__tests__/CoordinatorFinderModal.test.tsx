import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import CoordinatorFinderModal from "../CoordinatorFinderModal";
import type { Project, Task } from "../../../shared/types";

const getAllProjectTasks = vi.fn();
vi.mock("../../rpc", () => ({
	api: { request: { getAllProjectTasks: (...args: unknown[]) => getAllProjectTasks(...args) } },
}));

function project(id: string, name: string): Project {
	return { id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}

function task(id: string, seq: number, projectId: string, over: Partial<Task> = {}): Task {
	return {
		id, seq, projectId, title: `Task ${id}`, status: "in-progress", taskType: "coordinator", worktreePath: `/tmp/${id}`, ...over,
	} as Task;
}

const PROJECTS = new Map([
	["p1", project("p1", "dev-3.0")],
	["p2", project("p2", "billing")],
]);

function renderModal(tasks: Task[], opts: { currentTaskId?: string | null } = {}) {
	getAllProjectTasks.mockResolvedValue([
		{ projectId: "p1", tasks: tasks.filter((t) => t.projectId === "p1"), todoCount: 0 },
		{ projectId: "p2", tasks: tasks.filter((t) => t.projectId === "p2"), todoCount: 0 },
	]);
	const onSelect = vi.fn();
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<CoordinatorFinderModal
				projectById={PROJECTS}
				currentTaskId={opts.currentTaskId ?? null}
				mru={[]}
				onSelect={onSelect}
				onClose={onClose}
			/>
		</I18nProvider>,
	);
	return { onSelect, onClose };
}

beforeEach(() => {
	document.body.innerHTML = "";
	getAllProjectTasks.mockReset();
});

describe("CoordinatorFinderModal", () => {
	it("lists coordinators from every project and skips ordinary tasks", async () => {
		renderModal([
			task("a", 1, "p1", { title: "Coordinate the board" }),
			task("b", 2, "p2", { title: "Billing coordinator" }),
			task("c", 3, "p1", { title: "Coordinator lookalike", taskType: undefined }),
		]);
		expect(await screen.findByText("Coordinate the board")).toBeTruthy();
		expect(screen.getByText("Billing coordinator")).toBeTruthy();
		expect(screen.queryByText("Coordinator lookalike")).toBeNull();
		expect(screen.getByRole("dialog", { name: "Find coordinator" })).toBeTruthy();
	});

	it("matches on project name and opens the chosen coordinator with Enter", async () => {
		const user = userEvent.setup();
		const { onSelect } = renderModal([
			task("a", 1, "p1", { title: "Coordinate the board" }),
			task("b", 2, "p2", { title: "Money desk" }),
		]);
		await screen.findByText("Money desk");
		await user.type(screen.getByRole("textbox"), "billing");
		await waitFor(() => expect(screen.queryByText("Coordinate the board")).toBeNull());
		await user.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "b", projectId: "p2" }));
	});

	it("moves the selection with arrow keys and closes on Escape", async () => {
		const user = userEvent.setup();
		const { onSelect, onClose } = renderModal([task("a", 1, "p1"), task("b", 2, "p1")]);
		await screen.findByText("Task a");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("marks the current, hibernated and hidden coordinators", async () => {
		renderModal(
			[task("a", 1, "p1"), task("b", 2, "p1", { hibernated: true, hidden: true })],
			{ currentTaskId: "a" },
		);
		await screen.findByText("Task a");
		expect(screen.getByTestId("coordinator-state-current").textContent).toBe("Current");
		expect(screen.getByTestId("coordinator-state-hibernated").textContent).toBe("Hibernated");
		expect(screen.getByText("Hidden")).toBeTruthy();
	});

	it("explains how to get a coordinator when there is none", async () => {
		renderModal([task("c", 3, "p1", { taskType: undefined })]);
		expect(await screen.findByText(/No active coordinators/)).toBeTruthy();
	});

	it("says no match when the query filters everything out", async () => {
		const user = userEvent.setup();
		renderModal([task("a", 1, "p1")]);
		await screen.findByText("Task a");
		await user.type(screen.getByRole("textbox"), "zzzzqqq");
		expect(await screen.findByText("No coordinator matches")).toBeTruthy();
	});
});
