import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskContextMenu from "../../components/TaskContextMenu";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { installTaskMenuBuiltins } from "./install-builtins";
import { getTaskMenuRegistry, TASK_MENU_GROUPS, type TaskMenuItem } from "../registry";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

const project = { id: "p1", name: "Proj", path: "/tmp/p1", labels: [] } as unknown as Project;
const task = { id: "t1", projectId: "p1", description: "My task", status: "in-progress", worktreePath: "/w", branchName: "b" } as Task;

function renderMenu() {
	render(
		<I18nProvider>
			<TaskContextMenu task={task} project={project} dispatch={vi.fn()} pos={{ x: 0, y: 0 }} onClose={vi.fn()} onOpenTask={vi.fn()} />
		</I18nProvider>,
	);
}

/** Row test ids and `---` separators, in document order. */
function layout(): string[] {
	return [...document.querySelectorAll("[data-menu-row], .border-t")].map((el) => (el as HTMLElement).dataset.testid ?? "---");
}

/** Cordis applies a plugin on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Registers from a plugin of its own, as a later contributor would. */
async function contribute(name: string, items: TaskMenuItem[]) {
	getAppRoot().plugin({
		name,
		inject: ["taskMenu"],
		apply(ctx) {
			for (const item of items) ctx.taskMenu.register(item);
		},
	});
	await settle();
}

beforeEach(installTaskMenuBuiltins);

describe("taskMenu slot", () => {
	it("is a contribution slot whose built-ins each name a known group", () => {
		const registry = getTaskMenuRegistry();
		expect(registry.kind).toBe("contribute");
		const entries = registry.list();
		expect(entries.length).toBeGreaterThan(0);
		for (const { def } of entries) {
			expect(def.id.startsWith("builtin:")).toBe(true);
			expect(TASK_MENU_GROUPS).toContain(def.region);
			expect(Boolean(def.run) !== Boolean(def.submenu)).toBe(true);
		}
	});

	it("puts a non-built-in item into one trailing group, never among dev3's rows", async () => {
		await contribute("acme", [{ id: "acme:ping", region: "open", order: -1, label: () => "Ping", run: () => {} }]);
		renderMenu();
		const rows = layout();
		expect(rows.slice(-3)).toEqual(["task-menu-delete", "---", "task-menu-acme:ping"]);
		expect(rows[0]).toBe("task-menu-open");
	});

	it("runs a contributed item with the task it was opened on", async () => {
		const run = vi.fn();
		await contribute("acme", [{ id: "acme:ping", region: "open", label: () => "Ping", run }]);
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-acme:ping"));
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ task, project }));
	});

	it("logs a failing run instead of letting it escape the click", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await contribute("acme", [
			{ id: "acme:throws", region: "open", label: () => "Throws", run: () => { throw new Error("sync"); } },
			{ id: "acme:rejects", region: "open", label: () => "Rejects", run: () => Promise.reject(new Error("async")) },
		]);
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-acme:throws"));
		renderMenu();
		await userEvent.click(screen.getAllByTestId("task-menu-acme:rejects")[0]);
		await settle();
		expect(spy.mock.calls.map((call) => call[0])).toEqual(['[taskMenu] "acme:throws" failed', '[taskMenu] "acme:rejects" failed']);
		spy.mockRestore();
	});

	it("drops only an item whose rule throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await contribute("acme", [{ id: "acme:broken", region: "open", label: () => "x", when: () => { throw new Error("boom"); }, run: () => {} }]);
		renderMenu();
		expect(screen.queryByTestId("task-menu-acme:broken")).not.toBeInTheDocument();
		expect(screen.getByTestId("task-menu-open")).toBeInTheDocument();
		spy.mockRestore();
	});

	it("leaves no rows once its plugin is disposed", async () => {
		const fiber = getAppRoot().plugin({ name: "acme", inject: ["taskMenu"], apply(ctx) { ctx.taskMenu.register({ id: "acme:x", region: "open", label: () => "x", run: () => {} }); } });
		await settle();
		expect(getTaskMenuRegistry().get("acme:x")).toBeDefined();
		await fiber.dispose();
		expect(getTaskMenuRegistry().get("acme:x")).toBeUndefined();
	});
});
