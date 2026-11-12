import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPalette, { type GoToMode } from "../GoToPalette";
import type { Project, Space, Task } from "../../../shared/types";
import { setStreamerMode } from "../../streamer-mode";

const getAllProjectTasks = vi.fn();
let spacesResponse: Space[] = [];
vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: spacesResponse, order: spacesResponse.map((sp) => sp.id) })),
			getAllProjectTasks: (...args: unknown[]) => getAllProjectTasks(...args),
		},
	},
}));

function project(id: string, name: string): Project {
	return { id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}

function task(id: string, seq: number, projectId: string, over: Partial<Task> = {}): Task {
	return { id, seq, projectId, title: `Task ${id}`, status: "in-progress", worktreePath: `/tmp/${id}`, ...over } as Task;
}

const PROJECTS: Project[] = [project("p1", "users-service"), project("p2", "auth-gateway"), project("p3", "billing")];
const PROJECT_BY_ID = new Map(PROJECTS.map((p) => [p.id, p]));

interface HarnessProps {
	initialMode?: GoToMode;
	tasks?: Task[];
	onSelectProject?: (id: string) => void;
	onSelectSpace?: (id: string) => void;
	onSelectTask?: (t: Task) => void;
	onClose?: () => void;
	shortcutIndexById?: Record<string, number>;
	projects?: Project[];
	currentTaskId?: string;
}

function Harness({
	initialMode = "project", tasks = [], onSelectProject = vi.fn(), onSelectSpace = vi.fn(), onSelectTask = vi.fn(), onClose = vi.fn(),
	shortcutIndexById, projects = PROJECTS, currentTaskId,
}: HarnessProps) {
	const [mode, setMode] = useState<GoToMode>(initialMode);
	getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: tasks.filter((t) => t.projectId === "p1"), todoCount: 0 }, { projectId: "p2", tasks: tasks.filter((t) => t.projectId === "p2"), todoCount: 0 }]);
	return (
		<I18nProvider>
			<GoToPalette
				mode={mode}
				onModeChange={setMode}
				projects={projects}
				shortcutIndexById={shortcutIndexById}
				projectById={new Map(projects.map((p) => [p.id, p]))}
				taskPorts={new Map()}
				currentTaskId={currentTaskId}
				onSelectProject={onSelectProject}
				onSelectSpace={onSelectSpace}
				onSelectTask={onSelectTask}
				onClose={onClose}
			/>
		</I18nProvider>
	);
}

beforeEach(() => {
	document.body.innerHTML = "";
	getAllProjectTasks.mockReset();
	spacesResponse = [];
	setStreamerMode(false);
	try {
		localStorage.clear();
	} catch {
		/* ignore */
	}
});

describe("GoToPalette — project mode", () => {
	it("lists projects and filters as the user types", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.getByText("billing")).toBeTruthy();
		await user.type(screen.getByRole("textbox"), "auth");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("auth-gateway");
	});

	it("selects the top match on Enter and closes on Escape", async () => {
		const user = userEvent.setup();
		const onSelectProject = vi.fn();
		const onClose = vi.fn();
		render(<Harness onSelectProject={onSelectProject} onClose={onClose} />);
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("renders the ⌘N badge from the board index, not the display row", () => {
		// billing sits at board index 2 but is shown first (recency): it reads ⌘3.
		render(<Harness projects={[PROJECTS[2], PROJECTS[0], PROJECTS[1]]} shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }} />);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("billing");
		expect(options[0].textContent).toContain("⌘3");
		expect(options[1].textContent).toContain("⌘1");
	});

	it("renders the builtin Operations board with its bracketed name and ⌘0 badge", () => {
		const ops: Project = { ...project("vp1", "Operations"), kind: "virtual", builtin: true };
		render(<Harness projects={[ops, PROJECTS[0]]} shortcutIndexById={{ p1: 0 }} />);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("[ Operations ]");
		expect(options[0].textContent).toContain("⌘0");
		expect(options[1].textContent).toContain("⌘1");
	});

	it("moves the selection with arrow keys", async () => {
		const user = userEvent.setup();
		const onSelectProject = vi.fn();
		render(<Harness onSelectProject={onSelectProject} />);
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p2");
	});

	it("shows the empty state when nothing matches", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching projects")).toBeTruthy();
	});
});

describe("GoToPalette — spaces", () => {
	const rowTexts = () => screen.getAllByRole("option").map((el) => el.textContent ?? "");
	beforeEach(() => {
		spacesResponse = [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 } as Space];
	});

	it("lists every space as its own row, after the projects", async () => {
		render(<Harness />);
		await waitFor(() => expect(rowTexts()).toHaveLength(4));
		expect(rowTexts()[3]).toContain("Client X");
	});

	it("a space-name query finds the space and its member project, without leaking the name into the label", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await waitFor(() => expect(rowTexts()).toHaveLength(4));
		await user.type(screen.getByRole("textbox"), "client");
		await waitFor(() => {
			const rows = rowTexts();
			expect(rows).toHaveLength(2);
			const projectRow = rows.find((row) => row.includes("users-service"));
			expect(projectRow).toBeTruthy();
			expect(projectRow).not.toContain("Client X");
			expect(rows.some((row) => row.includes("Client X"))).toBe(true);
		});
	});

	it("badges a space row with its ⌘N digit while the query is empty", async () => {
		render(<Harness shortcutIndexById={{ sp_a: 2, p2: 0 }} />);
		await waitFor(() => expect(rowTexts()).toHaveLength(4));
		expect(rowTexts()[3]).toContain("⌘3");
	});

	it("selecting a space row reports the space, never a project", async () => {
		const user = userEvent.setup();
		const onSelectProject = vi.fn();
		const onSelectSpace = vi.fn();
		render(<Harness onSelectProject={onSelectProject} onSelectSpace={onSelectSpace} />);
		await waitFor(() => expect(rowTexts()).toHaveLength(4));
		await user.click(screen.getByText("Client X"));
		expect(onSelectSpace).toHaveBeenCalledWith("sp_a");
		expect(onSelectProject).not.toHaveBeenCalled();
	});
});

describe("GoToPalette — sensitive projects in streamer mode", () => {
	it("masks a locked project and its tasks and shows the lock glyph instead of a badge", async () => {
		setStreamerMode(true);
		const secret: Project = { ...project("p1", "users-service"), sensitive: true };
		render(
			<Harness
				initialMode="combined"
				projects={[secret, PROJECTS[1]]}
				shortcutIndexById={{ p1: 0, p2: 1 }}
				tasks={[task("a", 1, "p1", { title: "Secret task" }), task("b", 2, "p2", { title: "Open task" })]}
			/>,
		);
		await screen.findByText("Secret task");
		const row = (text: string) => screen.getAllByRole("option").find((el) => el.textContent?.includes(text))!;
		// The row's own title span — the project name on a task row is masked separately.
		const title = (text: string) => row(text).querySelector("span.text-fg")!;
		expect(title("users-service").classList).toContain("streamer-private");
		expect(row("users-service").querySelector('[aria-label="Sensitive project — locked while streamer mode is on"]')).toBeTruthy();
		expect(row("users-service").textContent).not.toContain("⌘1");
		expect(title("Secret task").classList).toContain("streamer-private");
		expect(row("Secret task").textContent).toContain("users-service");
		expect(row("Secret task").querySelector("span.text-fg-3.streamer-private")).toBeTruthy();
		expect(row("auth-gateway").querySelector(".streamer-private")).toBeNull();
		expect(row("Open task").querySelector(".streamer-private")).toBeNull();
	});
});

describe("GoToPalette — task mode", () => {
	it("loads cross-project tasks, newest-seq first, and opens one on Enter", async () => {
		const user = userEvent.setup();
		const onSelectTask = vi.fn();
		render(<Harness initialMode="task" tasks={[task("a", 1, "p1", { title: "Fix login" }), task("b", 7, "p2", { title: "Refactor billing" })]} onSelectTask={onSelectTask} />);
		await screen.findByText("Fix login");
		const options = screen.getAllByRole("option");
		// Higher seq (7) first with no recency recorded.
		expect(options[0].textContent).toContain("Refactor billing");
		await user.keyboard("{Enter}");
		expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
	});

	it("filters with a token-DSL query (reuses the sidebar engine)", async () => {
		const user = userEvent.setup();
		render(<Harness initialMode="task" tasks={[task("a", 1, "p1", { title: "Visible one", status: "in-progress" }), task("b", 2, "p1", { title: "Hidden one", hidden: true })]} />);
		await screen.findByText("Visible one");
		await user.type(screen.getByRole("textbox"), "is:hidden");
		await waitFor(() => {
			const rows = screen.getAllByRole("option");
			expect(rows).toHaveLength(1);
			expect(rows[0].textContent).toContain("Hidden one");
		});
	});

	it("sinks the task on screen to the bottom so Enter moves somewhere", async () => {
		const user = userEvent.setup();
		const onSelectTask = vi.fn();
		localStorage.setItem("dev3-recent-tasks-v1", JSON.stringify(["a", "b"]));
		render(<Harness initialMode="task" currentTaskId="a" tasks={[task("a", 1, "p1", { title: "Here now" }), task("b", 2, "p1", { title: "Was before" })]} onSelectTask={onSelectTask} />);
		await screen.findByText("Here now");
		const rows = screen.getAllByRole("option").map((r) => r.textContent ?? "");
		expect(rows[0]).toContain("Was before");
		expect(rows[1]).toContain("Here now");
		await user.keyboard("{Enter}");
		expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
	});

	it("says the task pool failed to load instead of reporting no matches", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		getAllProjectTasks.mockRejectedValue(new Error("boom"));
		render(
			<I18nProvider>
				<GoToPalette mode="task" onModeChange={vi.fn()} projects={PROJECTS} projectById={PROJECT_BY_ID} taskPorts={new Map()} onSelectProject={vi.fn()} onSelectSpace={vi.fn()} onSelectTask={vi.fn()} onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(await screen.findByText("Couldn’t load tasks")).toBeTruthy();
		spy.mockRestore();
	});

	it("shows a loading state until the task pool resolves", async () => {
		let resolve: (v: unknown) => void = () => {};
		getAllProjectTasks.mockReturnValue(new Promise((r) => { resolve = r; }));
		render(
			<I18nProvider>
				<GoToPalette mode="task" onModeChange={vi.fn()} projects={PROJECTS} projectById={PROJECT_BY_ID} taskPorts={new Map()} onSelectProject={vi.fn()} onSelectSpace={vi.fn()} onSelectTask={vi.fn()} onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(screen.getByText("Loading tasks…")).toBeTruthy();
		resolve([{ projectId: "p1", tasks: [task("a", 1, "p1", { title: "Arrived" })], todoCount: 0 }]);
		expect(await screen.findByText("Arrived")).toBeTruthy();
	});
});

describe("GoToPalette — combined mode and switching", () => {
	it("lists both projects and tasks in combined mode", async () => {
		render(<Harness initialMode="combined" tasks={[task("a", 1, "p1", { title: "Combined task" })]} />);
		await screen.findByText("Combined task");
		expect(screen.getByText("users-service")).toBeTruthy();
	});

	it("interleaves projects and tasks by the unified visit timeline in combined mode", async () => {
		// Visit order (newest first): Task A, project p2 (auth-gateway), Task B.
		localStorage.setItem("dev3-recent-nav-v1", JSON.stringify(["t:a", "p:p2", "t:b"]));
		render(<Harness initialMode="combined" tasks={[task("a", 1, "p1", { title: "Task A" }), task("b", 2, "p2", { title: "Task B" })]} />);
		await screen.findByText("Task A");
		const rows = screen.getAllByRole("option").map((r) => r.textContent ?? "");
		// A task, then a project, then a task — mixed, not all-projects-then-all-tasks.
		expect(rows[0]).toContain("Task A");
		expect(rows[1]).toContain("auth-gateway");
		expect(rows[2]).toContain("Task B");
	});

	it("switches mode on a strip click and on Tab", async () => {
		const user = userEvent.setup();
		render(<Harness initialMode="project" tasks={[task("a", 1, "p1", { title: "Switched-to task" })]} />);
		// Start in projects mode: the project rows are there, the task is not.
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.queryByText("Switched-to task")).toBeNull();
		// Click the Tasks tab on the mode strip.
		await user.click(screen.getByTestId("go-to-mode-task"));
		expect(await screen.findByText("Switched-to task")).toBeTruthy();
		// Tab from Tasks cycles to Combined, where projects are listed again.
		await user.keyboard("{Tab}");
		await waitFor(() => expect(screen.getByText("users-service")).toBeTruthy());
	});
});
