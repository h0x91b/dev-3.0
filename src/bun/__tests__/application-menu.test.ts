import { describe, expect, it } from "vitest";
import { buildApplicationMenu, MENU_ACTIONS } from "../application-menu";

function findLabeledMenu(menu: ReturnType<typeof buildApplicationMenu>, label: string) {
	return menu.find((item) => "label" in item && item.label === label) as { submenu?: Array<{ action?: string; label?: string; accelerator?: string }> } | undefined;
}

describe("buildApplicationMenu", () => {
	it("adds File > New Task with Command+N", () => {
		const menu = buildApplicationMenu();
		const fileMenu = findLabeledMenu(menu, "File");
		const newTaskItem = fileMenu?.submenu?.find((item: any) => item.action === MENU_ACTIONS.openNewTask);

		expect(newTaskItem).toMatchObject({
			label: "New Task",
			action: MENU_ACTIONS.openNewTask,
			accelerator: "n",
		});
	});

	it("moves Add Project to Command+P", () => {
		const menu = buildApplicationMenu();
		const fileMenu = findLabeledMenu(menu, "File");
		const addProjectItem = fileMenu?.submenu?.find((item: any) => item.action === MENU_ACTIONS.openAddProject);

		expect(addProjectItem).toMatchObject({
			label: "Add Project...",
			action: MENU_ACTIONS.openAddProject,
			accelerator: "p",
		});
	});
});
