import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { Context } from "cordis";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import TaskDock, { splitDockTabs } from "../TaskDock";
import TaskPanelInstances from "../TaskPanelInstances";
import { activateTaskPanel, closeTaskPanel, getTaskDock, openTaskPanel } from "../dock-store";
import type { TaskPanelProps } from "../registry";
import { installTaskPanelBuiltins } from "./install-builtins";

/** An extension-shaped panel: non-builtin id, its own state, registered from a plugin. */
function Notes({ taskId, presentation }: TaskPanelProps) {
	const [count, setCount] = useState(0);
	return (
		<div data-testid={`notes-${taskId}`} data-presentation={presentation}>
			<button type="button" onClick={() => setCount((value) => value + 1)}>bump</button>
			<span data-testid={`notes-count-${taskId}`}>{count}</span>
		</div>
	);
}

async function registerPanels(ids: string[]) {
	getAppRoot().plugin({
		name: "test-panels",
		inject: ["taskPanels"],
		apply(ctx: Context) {
			ids.forEach((id, order) => ctx.taskPanels.register({ id, order: order + 1, title: () => id.replace("ext:", ""), component: Notes }));
		},
	});
	for (let tick = 0; tick < 50 && !ids.every((id) => getAppRoot().taskPanels.get(id)); tick++) await Promise.resolve();
}

function Screen({ taskId, covered = false, canDock = true }: { taskId: string | null; covered?: boolean; canDock?: boolean }) {
	return (
		<I18nProvider>
			<TaskPanelInstances />
			{taskId && <div className="flex"><TaskDock taskId={taskId} covered={covered} canDock={canDock} /></div>}
		</I18nProvider>
	);
}

beforeEach(async () => {
	localStorage.clear();
	await installTaskPanelBuiltins();
});

describe("dock store", () => {
	it("opens behind the active tab unless asked to activate, and closes back to the remembered pick", () => {
		openTaskPanel("t1", "ext:a");
		openTaskPanel("t1", "ext:b", { activate: false });
		expect(getTaskDock("t1")).toEqual({ open: ["ext:a", "ext:b"], active: "ext:a" });
		openTaskPanel("t1", "ext:c");
		expect(getTaskDock("t1").active).toBe("ext:c");
		activateTaskPanel("t1", "ext:b");
		closeTaskPanel("t1", "ext:c");
		expect(getTaskDock("t1").active).toBe("ext:b");
		closeTaskPanel("t1", "ext:a");
		closeTaskPanel("t1", "ext:b");
		expect(getTaskDock("t1")).toEqual({ open: [], active: null });
	});

	it("remembers the picked tab per task across a reload of the docks", async () => {
		openTaskPanel("t1", "ext:a");
		openTaskPanel("t1", "ext:b");
		activateTaskPanel("t1", "ext:a");
		await installTaskPanelBuiltins();
		openTaskPanel("t1", "ext:b");
		openTaskPanel("t1", "ext:a", { activate: false });
		expect(getTaskDock("t1").active).toBe("ext:a");
		openTaskPanel("t2", "ext:b");
		openTaskPanel("t2", "ext:a", { activate: false });
		expect(getTaskDock("t2").active).toBe("ext:b");
	});
});

describe("splitDockTabs", () => {
	const tabs = ["a", "b", "c", "d", "e", "f"].map((id) => ({ def: { id } }));
	it("shows four tabs and keeps an active fifth one visible", () => {
		expect(splitDockTabs(tabs.slice(0, 4), "a").more).toEqual([]);
		const { visible, more } = splitDockTabs(tabs, "f");
		expect(visible.map((tab) => tab.def.id)).toEqual(["a", "b", "c", "f"]);
		expect(more.map((tab) => tab.def.id)).toEqual(["d", "e"]);
	});
});

describe("task dock", () => {
	it("shows no tab strip for one panel, tabs from two, and More past four", async () => {
		await registerPanels(["ext:a", "ext:b", "ext:c", "ext:d", "ext:e"]);
		render(<Screen taskId="t1" />);
		act(() => openTaskPanel("t1", "ext:a"));
		expect(screen.getByTestId("task-dock")).toBeInTheDocument();
		expect(screen.queryByRole("tablist")).toBeNull();
		act(() => {
			for (const id of ["ext:b", "ext:c", "ext:d", "ext:e"]) openTaskPanel("t1", id, { activate: false });
		});
		const tablist = screen.getByRole("tablist");
		expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["a", "b", "c", "d"]);
		fireEvent.click(screen.getByRole("button", { name: "More" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "e" }));
		expect(getTaskDock("t1").active).toBe("ext:e");
		expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("e");
		const shown = screen.getAllByTestId("notes-t1").filter((el) => el.dataset.presentation === "docked");
		expect(shown).toHaveLength(1);
		expect(shown[0].parentElement).toHaveAttribute("data-task-panel", "ext:e");
	});

	it("closes a tab from its ✕ and brings the neighbour forward", async () => {
		await registerPanels(["ext:a", "ext:b"]);
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:a");
			openTaskPanel("t1", "ext:b");
		});
		fireEvent.click(screen.getByRole("button", { name: "Close b" }));
		expect(getTaskDock("t1")).toEqual({ open: ["ext:a"], active: "ext:a" });
	});

	it("keeps an extension panel's state across a task switch and back", async () => {
		await registerPanels(["ext:notes"]);
		const { rerender } = render(<Screen taskId="t1" />);
		act(() => openTaskPanel("t1", "ext:notes"));
		fireEvent.click(within(screen.getByTestId("task-dock")).getByRole("button", { name: "bump" }));
		expect(screen.getByTestId("notes-count-t1")).toHaveTextContent("1");

		rerender(<Screen taskId="t2" />);
		expect(screen.queryByTestId("task-dock")).toBeNull();
		const parked = screen.getByTestId("notes-t1");
		expect(parked).toHaveAttribute("data-presentation", "offscreen");
		expect(screen.getByTestId("task-panels-parking")).toContainElement(parked);

		rerender(<Screen taskId="t1" />);
		expect(screen.getByTestId("task-dock")).toContainElement(screen.getByTestId("notes-t1"));
		expect(screen.getByTestId("notes-t1")).toHaveAttribute("data-presentation", "docked");
		expect(screen.getByTestId("notes-count-t1")).toHaveTextContent("1");
	});

	it("parks panels with no dock on screen: narrow/immersive, inline diff, inactive tab", async () => {
		await registerPanels(["ext:a", "ext:b"]);
		const { rerender } = render(<Screen taskId="t1" canDock={false} />);
		act(() => {
			openTaskPanel("t1", "ext:a");
			openTaskPanel("t1", "ext:b", { activate: false });
		});
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(screen.getAllByTestId("notes-t1").map((el) => el.dataset.presentation)).toEqual(["undocked", "undocked"]);
		rerender(<Screen taskId="t1" covered />);
		expect(screen.getAllByTestId("notes-t1").map((el) => el.dataset.presentation)).toEqual(["offscreen", "offscreen"]);
		rerender(<Screen taskId="t1" />);
		expect(screen.getAllByTestId("notes-t1").map((el) => el.dataset.presentation)).toEqual(["docked", "inactive"]);
		const inactiveHost = screen.getAllByTestId("notes-t1")[1].parentElement!;
		expect(inactiveHost.hidden).toBe(true);
	});

	it("drops a crashing panel without taking the dock down", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		getAppRoot().plugin({
			name: "crashing",
			inject: ["taskPanels"],
			apply(ctx: Context) {
				ctx.taskPanels.register({ id: "ext:boom", title: () => "boom", component: () => { throw new Error("boom"); } });
			},
		});
		await registerPanels(["ext:fine"]);
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:boom");
			openTaskPanel("t1", "ext:fine", { activate: false });
		});
		expect(screen.getByRole("tablist")).toBeInTheDocument();
		expect(screen.getByTestId("notes-t1")).toBeInTheDocument();
		spy.mockRestore();
	});
});
