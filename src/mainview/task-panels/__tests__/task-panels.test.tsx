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
			<TaskPanelInstances tasks={[]} />
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
		expect(getTaskDock("t1")).toEqual({ open: ["ext:a", "ext:b"], active: "ext:a", floating: [] });
		openTaskPanel("t1", "ext:c");
		expect(getTaskDock("t1").active).toBe("ext:c");
		activateTaskPanel("t1", "ext:b");
		closeTaskPanel("t1", "ext:c");
		expect(getTaskDock("t1").active).toBe("ext:b");
		closeTaskPanel("t1", "ext:a");
		closeTaskPanel("t1", "ext:b");
		expect(getTaskDock("t1")).toEqual({ open: [], active: null, floating: [] });
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
	const ids = (list: readonly { def: { id: string } }[]) => list.map((tab) => tab.def.id);
	const tabs = ["ext:a", "ext:b", "ext:c", "ext:d", "ext:e", "ext:f"].map((id) => ({ def: { id } }));
	it("shows four tabs and keeps an active fifth one visible", () => {
		expect(splitDockTabs(tabs.slice(0, 4), "ext:a").more).toEqual([]);
		const { visible, more } = splitDockTabs(tabs, "ext:f");
		expect(ids(visible)).toEqual(["ext:a", "ext:b", "ext:c", "ext:f"]);
		expect(ids(more)).toEqual(["ext:d", "ext:e"]);
	});

	it("puts built-ins first and never folds them into More, whatever was opened first", () => {
		const opened = [...tabs.slice(0, 4), { def: { id: "builtin:y", order: 2 } }, { def: { id: "builtin:x", order: 1 } }];
		const { visible, more } = splitDockTabs(opened, "ext:d");
		expect(ids(visible)).toEqual(["builtin:x", "builtin:y", "ext:a", "ext:d"]);
		expect(ids(more)).toEqual(["ext:b", "ext:c"]);
		const crowded = ["builtin:1", "builtin:2", "builtin:3", "builtin:4"].map((id) => ({ def: { id } }));
		const full = splitDockTabs([...crowded, tabs[0], tabs[1]], "ext:b");
		expect(ids(full.visible)).toEqual(["builtin:1", "builtin:2", "builtin:3", "builtin:4", "ext:b"]);
		expect(ids(full.more)).toEqual(["ext:a"]);
	});
});

describe("task dock", () => {
	it("shows a tab per open panel and More past four", async () => {
		await registerPanels(["ext:a", "ext:b", "ext:c", "ext:d", "ext:e"]);
		render(<Screen taskId="t1" />);
		act(() => openTaskPanel("t1", "ext:a"));
		expect(screen.getByTestId("task-dock")).toBeInTheDocument();
		expect(screen.getAllByRole("tab")).toHaveLength(1);
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
		expect(getTaskDock("t1")).toEqual({ open: ["ext:a"], active: "ext:a", floating: [] });
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

	function registerCrashing(id: string) {
		getAppRoot().plugin({
			name: `crashing-${id}`,
			inject: ["taskPanels"],
			apply(ctx: Context) {
				ctx.taskPanels.register({ id, title: () => "boom", component: () => { throw new Error("boom"); } });
			},
		});
	}

	it("drops a crashed extension panel from the dock and brings a live tab forward", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		registerCrashing("ext:boom");
		await registerPanels(["ext:fine"]);
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:fine");
			openTaskPanel("t1", "ext:boom");
		});
		expect(getTaskDock("t1").open).toEqual(["ext:fine"]);
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("fine");
		expect(screen.getByTestId("notes-t1")).toHaveAttribute("data-presentation", "docked");
		spy.mockRestore();
	});

	it("keeps a crashed built-in panel's tab and says so in its body", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		registerCrashing("builtin:boom");
		await registerPanels(["ext:fine"]);
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:fine", { activate: false });
			openTaskPanel("t1", "builtin:boom");
		});
		expect(getTaskDock("t1").open).toContain("builtin:boom");
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("boom");
		expect(within(screen.getByTestId("task-dock-body")).getByRole("alert")).toHaveTextContent("This panel stopped working.");
		fireEvent.click(within(screen.getByTestId("task-panel-crashed")).getByRole("button", { name: "Close" }));
		expect(getTaskDock("t1").open).toEqual(["ext:fine"]);
		spy.mockRestore();
	});

	it("re-picks the front tab when the active panel's plugin goes away", async () => {
		await registerPanels(["ext:stay"]);
		const fiber = getAppRoot().plugin({
			name: "leaving",
			inject: ["taskPanels"],
			apply(ctx: Context) {
				ctx.taskPanels.register({ id: "ext:gone", title: () => "gone", component: Notes });
			},
		});
		for (let tick = 0; tick < 50 && !getAppRoot().taskPanels.get("ext:gone"); tick++) await Promise.resolve();
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:stay");
			openTaskPanel("t1", "ext:gone");
		});
		await act(async () => {
			await fiber.dispose();
		});
		const tab = screen.getByRole("tab", { selected: true });
		expect(tab).toHaveTextContent("stay");
		expect(tab).toHaveAttribute("tabindex", "0");
		expect(screen.getByTestId("notes-t1")).toHaveAttribute("data-presentation", "docked");
	});

	it("gives a lone closable panel a strip with its ✕, and none to a lone non-closable one", async () => {
		await registerPanels(["ext:solo"]);
		const { unmount } = render(<Screen taskId="t1" />);
		act(() => openTaskPanel("t1", "ext:solo"));
		fireEvent.click(screen.getByRole("button", { name: "Close solo" }));
		expect(getTaskDock("t1").open).toEqual([]);
		unmount();
		render(<Screen taskId="t2" />);
		act(() => openTaskPanel("t2", "builtin:artifact"));
		expect(screen.getByTestId("task-dock")).toBeInTheDocument();
		expect(screen.queryByRole("tablist")).toBeNull();
	});

	it("closes the focused tab with Delete and resizes the dock from the keyboard", async () => {
		await registerPanels(["ext:a", "ext:b"]);
		render(<Screen taskId="t1" />);
		act(() => {
			openTaskPanel("t1", "ext:a");
			openTaskPanel("t1", "ext:b");
		});
		const selected = screen.getByRole("tab", { selected: true });
		selected.focus();
		fireEvent.keyDown(selected, { key: "Delete" });
		expect(getTaskDock("t1").open).toEqual(["ext:a"]);
		const dock = screen.getByTestId("task-dock");
		const before = parseFloat(dock.style.width);
		fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
		expect(parseFloat(dock.style.width)).toBe(before + 24);
		expect(localStorage.getItem("dev3-artifact-panel-width")).toBe(String(before + 24));
	});
});
