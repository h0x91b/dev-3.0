import { describe, expect, it } from "vitest";
import { buildApplicationMenu, MENU_ACTIONS } from "../application-menu";

type AnyMenuItem = {
	label?: string;
	action?: string;
	accelerator?: string;
	enabled?: boolean;
	role?: string;
	submenu?: AnyMenuItem[];
	type?: string;
};

function findLabeledMenu(menu: AnyMenuItem[], label: string): AnyMenuItem | undefined {
	return menu.find((item) => item.label === label);
}

function findItemByAction(menu: AnyMenuItem[], action: string): AnyMenuItem | undefined {
	for (const item of menu) {
		if (item.action === action) return item;
		if (item.submenu) {
			const found = findItemByAction(item.submenu, action);
			if (found) return found;
		}
	}
	return undefined;
}

describe("buildApplicationMenu", () => {
	it("exposes nine top-level menus in the expected order", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const labels = menu.map((item) => item.label);
		expect(labels).toEqual([
			"dev-3.0",
			"File",
			"Edit",
			"Task",
			"Project",
			"View",
			"Terminal",
			"Window",
			"Help",
		]);
	});

	it("adds File > New Task with Command+N", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const fileMenu = findLabeledMenu(menu, "File");
		const newTaskItem = fileMenu?.submenu?.find((item) => item.action === MENU_ACTIONS.openNewTask);
		expect(newTaskItem).toMatchObject({
			label: "New Task",
			action: MENU_ACTIONS.openNewTask,
			accelerator: "n",
			enabled: true,
		});
	});

	it("keeps Add Local Project on Command+P", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const fileMenu = findLabeledMenu(menu, "File");
		const addProjectItem = fileMenu?.submenu?.find((item) => item.action === MENU_ACTIONS.openAddProject);
		expect(addProjectItem).toMatchObject({
			label: "Add Local Project...",
			action: MENU_ACTIONS.openAddProject,
			accelerator: "p",
			enabled: true,
		});
	});

	it("nests Theme and Language submenus under the app menu", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const appMenu = findLabeledMenu(menu, "dev-3.0");
		const themeSubmenu = appMenu?.submenu?.find((item) => item.label === "Theme")?.submenu;
		const localeSubmenu = appMenu?.submenu?.find((item) => item.label === "Language")?.submenu;
		expect(themeSubmenu?.map((i) => i.action)).toEqual([
			MENU_ACTIONS.setThemeLight,
			MENU_ACTIONS.setThemeDark,
			MENU_ACTIONS.setThemeAuto,
		]);
		expect(localeSubmenu?.map((i) => i.action)).toEqual([
			MENU_ACTIONS.setLocaleEn,
			MENU_ACTIONS.setLocaleRu,
			MENU_ACTIONS.setLocaleEs,
		]);
	});

	it("exposes core tmux pane operations as enabled in the Terminal menu", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		expect(findItemByAction(menu, MENU_ACTIONS.termSplitH)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termSplitV)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termZoomPane)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termClosePane)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termLayoutTiled)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termLayoutCycle)?.enabled).toBe(true);
	});

	it("renders the mark/swap pane roadmap as disabled until follow-up", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		expect(findItemByAction(menu, MENU_ACTIONS.termMarkPane)?.enabled).toBe(false);
		expect(findItemByAction(menu, MENU_ACTIONS.termSwapMarked)?.enabled).toBe(false);
		expect(findItemByAction(menu, MENU_ACTIONS.termSyncPanes)?.enabled).toBe(false);
	});

	it("places the Tmux Cheat Sheet entry under both Terminal and Help", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const terminalCheat = findItemByAction(findLabeledMenu(menu, "Terminal")?.submenu ?? [], MENU_ACTIONS.termCheatSheet);
		const helpCheat = findItemByAction(findLabeledMenu(menu, "Help")?.submenu ?? [], MENU_ACTIONS.termCheatSheet);
		expect(terminalCheat?.enabled).toBe(true);
		expect(helpCheat?.enabled).toBe(true);
	});

	it("provides project git ops in the Project menu", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		expect(findItemByAction(menu, MENU_ACTIONS.projectPullMain)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.projectCreatePr)?.enabled).toBe(true);
		// Follow-up commits will wire push-branch / push-and-create-pr.
		expect(findItemByAction(menu, MENU_ACTIONS.projectPushBranch)?.enabled).toBe(false);
	});

	it("keeps the Window menu standard (minimize / zoom / cycle / close)", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		const windowMenu = findLabeledMenu(menu, "Window");
		const roles = windowMenu?.submenu?.filter((i) => i.role).map((i) => i.role) ?? [];
		expect(roles).toContain("minimize");
		expect(roles).toContain("zoom");
		expect(roles).toContain("cycleThroughWindows");
		expect(roles).toContain("close");
	});
});
