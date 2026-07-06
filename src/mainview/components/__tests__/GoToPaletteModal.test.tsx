import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPaletteModal from "../GoToPaletteModal";
import type { Project, Task } from "../../../shared/types";

function project(id: string, name: string): Project {
	return {
		id,
		name,
		path: `/tmp/${id}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "",
	};
}

function task(id: string, projectId: string, title: string): Task {
	return {
		id,
		seq: 1,
		projectId,
		title,
		description: "",
		status: "in-progress",
		createdAt: "",
		updatedAt: "",
	} as Task;
}

const PROJECTS: Project[] = [
	project("p1", "users-service"),
	project("p2", "auth-gateway"),
	project("p3", "billing"),
];

const TASKS: Task[] = [
	task("t1", "p1", "Fix login redirect"),
	task("t2", "p2", "Add rate limiter"),
];

const PROJECT_BY_ID = new Map(PROJECTS.map((p) => [p.id, p]));

function renderModal(
	handlers: {
		onSelectProject?: (id: string) => void;
		onSelectTask?: (t: Task) => void;
		onClose?: () => void;
	} = {},
) {
	const onSelectProject = handlers.onSelectProject ?? vi.fn();
	const onSelectTask = handlers.onSelectTask ?? vi.fn();
	const onClose = handlers.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<GoToPaletteModal
				projects={PROJECTS}
				tasks={TASKS}
				projectById={PROJECT_BY_ID}
				onSelectProject={onSelectProject}
				onSelectTask={onSelectTask}
				onClose={onClose}
			/>
		</I18nProvider>,
	);
	return { onSelectProject, onSelectTask, onClose };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("GoToPaletteModal", () => {
	it("traps focus inside the dialog on open", () => {
		renderModal();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("lists all projects and tasks initially, projects first", () => {
		renderModal();
		const options = screen.getAllByRole("option");
		// Projects come before tasks (fixed section order).
		expect(options[0].textContent).toContain("users-service");
		expect(options).toHaveLength(PROJECTS.length + TASKS.length);
		expect(screen.getByText("Fix login redirect")).toBeTruthy();
		expect(screen.getByText("Add rate limiter")).toBeTruthy();
	});

	it("renders both section headers", () => {
		renderModal();
		expect(screen.getByText("Projects")).toBeTruthy();
		expect(screen.getByText("Tasks · recently visited")).toBeTruthy();
	});

	it("shows the project badge on task rows", () => {
		renderModal();
		const taskRow = screen.getByText("Fix login redirect").closest("[role=option]");
		expect(taskRow?.textContent).toContain("users-service");
	});

	it("filters both projects and tasks as the user types", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "login");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("Fix login redirect");
	});

	it("opens a project on Enter over a project match", async () => {
		const user = userEvent.setup();
		const { onSelectProject } = renderModal();
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
	});

	it("opens a task on click", async () => {
		const user = userEvent.setup();
		const { onSelectTask } = renderModal();
		await user.click(screen.getByText("Add rate limiter"));
		expect(onSelectTask).toHaveBeenCalledWith(TASKS[1]);
	});

	it("navigates across the flat row list with arrow keys, skipping headers", async () => {
		const user = userEvent.setup();
		const { onSelectProject } = renderModal();
		// Rows: p1, p2, p3, t1, t2. ArrowDown once → p2.
		await user.keyboard("{ArrowDown}");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p2");
	});

	it("shows an empty state when nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching projects or tasks")).toBeTruthy();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("renders the ⌘N badge from the board index, not the display row", () => {
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[PROJECTS[2], PROJECTS[0], PROJECTS[1]]}
					tasks={[]}
					projectById={PROJECT_BY_ID}
					shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("billing");
		expect(options[0].textContent).toContain("⌘3");
		expect(options[1].textContent).toContain("⌘1");
	});

	it("renders the builtin Operations board with its bracketed name and ⌘0 badge", () => {
		const ops: Project = { ...project("vp1", "Operations"), kind: "virtual", builtin: true };
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[ops, PROJECTS[0]]}
					tasks={[]}
					projectById={
						new Map([
							[ops.id, ops],
							[PROJECTS[0].id, PROJECTS[0]],
						])
					}
					shortcutIndexById={{ p1: 0 }}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("[ Operations ]");
		expect(options[0].textContent).toContain("⌘0");
		expect(options[1].textContent).toContain("⌘1");
	});
});
