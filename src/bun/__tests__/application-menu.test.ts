import { describe, expect, it } from "vitest";
import { buildApplicationMenu, MENU_ACTIONS, type MenuContext } from "../../shared/application-menu";

const FULL_CONTEXT: MenuContext = { hasTask: true, hasProject: true, hasTerminal: true };
const PROJECT_ONLY: MenuContext = { hasTask: false, hasProject: true, hasTerminal: false };

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
	it("lays out the default menu: nine top-level menus, File items, zoom, Theme/Language and a standard Window menu", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[];
		expect(menu.map((item) => item.label)).toEqual([
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

		const fileMenu = findLabeledMenu(menu, "File")?.submenu ?? [];
		expect(fileMenu[0], "New Window is the first File item").toMatchObject({ label: "New Window", action: MENU_ACTIONS.newWindow });
		expect(fileMenu.find((item) => item.action === MENU_ACTIONS.openNewTask), "New Task on Command+N").toMatchObject({
			label: "New Task",
			action: MENU_ACTIONS.openNewTask,
			accelerator: "n",
			enabled: true,
		});
		expect(fileMenu.find((item) => item.action === MENU_ACTIONS.openAddProject), "Add Local Project on Command+P").toMatchObject({
			label: "Add Local Project...",
			action: MENU_ACTIONS.openAddProject,
			accelerator: "p",
			enabled: true,
		});

		// Ctrl+- stays free for route history instead of native zoom-out.
		const zoomOut = findItemByAction(menu, MENU_ACTIONS.zoomOut);
		expect(zoomOut).toMatchObject({ label: "Zoom Out (⌘- / Ctrl+Alt+-)", enabled: true });
		expect(zoomOut?.accelerator, "zoom-out has no native accelerator").toBeUndefined();

		const appMenu = findLabeledMenu(menu, "dev-3.0");
		expect(appMenu?.submenu?.find((item) => item.label === "Theme")?.submenu?.map((i) => i.action), "Theme submenu").toEqual([
			MENU_ACTIONS.setThemeLight,
			MENU_ACTIONS.setThemeDark,
			MENU_ACTIONS.setThemeAuto,
		]);
		expect(appMenu?.submenu?.find((item) => item.label === "Language")?.submenu?.map((i) => i.action), "Language submenu").toEqual([
			MENU_ACTIONS.setLocaleEn,
			MENU_ACTIONS.setLocaleRu,
			MENU_ACTIONS.setLocaleEs,
		]);

		const roles = findLabeledMenu(menu, "Window")?.submenu?.filter((i) => i.role).map((i) => i.role) ?? [];
		expect(roles, "standard Window menu").toEqual(expect.arrayContaining(["minimize", "zoom", "cycleThroughWindows", "close"]));
	});

	it("exposes the palettes at the top of View and the Agent Sessions screen, always enabled, with no native accelerator", () => {
		const menu = buildApplicationMenu({ hasTask: false, hasProject: false, hasTerminal: false }) as AnyMenuItem[];
		const submenu = findLabeledMenu(menu, "View")?.submenu ?? [];

		// The four palette openers lead View, ahead of Show Dashboard: the three
		// "Go to" modes then the command palette.
		const actionable = submenu.filter((item) => item.action);
		expect(actionable[0]).toMatchObject({ label: "Go to Project… (⇧⌘K)", action: MENU_ACTIONS.openProjectSwitch, enabled: true });
		expect(actionable[1]).toMatchObject({ label: "Go to Task… (⇧⌘J)", action: MENU_ACTIONS.openTaskSwitch, enabled: true });
		expect(actionable[2]).toMatchObject({ label: "Go to Anything… (⇧⌘L)", action: MENU_ACTIONS.openCombinedSwitch, enabled: true });
		expect(actionable[3]).toMatchObject({ label: "Command Palette… (⇧⌘P)", action: MENU_ACTIONS.openCommandPalette, enabled: true });
		// Chords / toggles are owned by the renderer — no native accelerator.
		for (const item of actionable.slice(0, 4)) expect(item.accelerator, item.label).toBeUndefined();

		expect(findItemByAction(submenu, MENU_ACTIONS.viewSessions), "Agent Sessions routes to view-sessions").toMatchObject({
			label: "Show Agent Sessions",
			action: "view-sessions",
			enabled: true,
		});
	});

	it("has Show Board and a Board View submenu of the built-ins, enabled only with a project", () => {
		const find = (hasProject: boolean) => {
			const view = findLabeledMenu(buildApplicationMenu({ hasTask: false, hasProject, hasTerminal: false }) as AnyMenuItem[], "View")?.submenu ?? [];
			return { view, boardView: findLabeledMenu(view, "Board View")?.submenu ?? [] };
		};
		const { view, boardView } = find(true);
		expect(findItemByAction(view, MENU_ACTIONS.viewBoard)).toMatchObject({ label: "Show Board", action: "view-board" });
		expect(boardView.map((item) => [item.label, item.action, item.enabled])).toEqual([
			["Kanban", "view-board:builtin:kanban", true],
			["Table", "view-board:builtin:table", true],
			["Tree", "view-board:builtin:tree", true],
			["Attention", "view-board:builtin:attention", true],
		]);
		expect(find(false).boardView.every((item) => item.enabled === false)).toBe(true);
	});

	it("greys out tmux pane operations when no terminal is visible", () => {
		const menu = buildApplicationMenu(PROJECT_ONLY) as AnyMenuItem[];
		expect(findItemByAction(menu, MENU_ACTIONS.termSplitH)?.enabled).toBe(false);
		expect(findItemByAction(menu, MENU_ACTIONS.termSplitV)?.enabled).toBe(false);
		expect(findItemByAction(menu, MENU_ACTIONS.termLayoutTiled)?.enabled).toBe(false);
		expect(findItemByAction(menu, MENU_ACTIONS.termLayoutCycle)?.enabled).toBe(false);
		// Toggling the project terminal still works in a project-only context.
		expect(findItemByAction(menu, MENU_ACTIONS.termToggleProjectTerminal)?.enabled).toBe(true);
		// Quick shell and cheat sheet are always available.
		expect(findItemByAction(menu, MENU_ACTIONS.termOpenQuickShell)?.enabled).toBe(true);
		expect(findItemByAction(menu, MENU_ACTIONS.termCheatSheet)?.enabled).toBe(true);
	});

	it("enables tmux pane operations and project git ops when a task, project and terminal are in scope", () => {
		const menu = buildApplicationMenu(FULL_CONTEXT) as AnyMenuItem[];
		for (const action of [
			MENU_ACTIONS.termSplitH,
			MENU_ACTIONS.termSplitV,
			MENU_ACTIONS.termZoomPane,
			MENU_ACTIONS.termClosePane,
			MENU_ACTIONS.termLayoutTiled,
			MENU_ACTIONS.termLayoutCycle,
			// Live since `swapStep` landed on both backends — a working hotkey next to a
			// greyed-out menu item of the same name is a lie about what the app can do.
			MENU_ACTIONS.termSwapNext,
			MENU_ACTIONS.termSwapPrev,
			MENU_ACTIONS.projectPullMain,
			MENU_ACTIONS.projectCreatePr,
		]) {
			expect(findItemByAction(menu, action)?.enabled, action).toBe(true);
		}
		// Follow-up commits will wire push-branch.
		expect(findItemByAction(menu, MENU_ACTIONS.projectPushBranch)?.enabled, "push-branch stays disabled").toBe(false);
	});

	it("greys out task / project items and the mark/swap roadmap with nothing in scope, but keeps the cheat sheet in Terminal and Help", () => {
		const menu = buildApplicationMenu() as AnyMenuItem[]; // empty context
		for (const action of [
			MENU_ACTIONS.taskOpenInFinder,
			MENU_ACTIONS.taskCopyWorktreePath,
			MENU_ACTIONS.projectPullMain,
			MENU_ACTIONS.projectSettings,
			// Still roadmap: neither a marked pane nor rotation exists in the neutral
			// pane vocabulary, so nothing backs them.
			MENU_ACTIONS.termMarkPane,
			MENU_ACTIONS.termSwapMarked,
			MENU_ACTIONS.termRotateCw,
			MENU_ACTIONS.termSyncPanes,
		]) {
			expect(findItemByAction(menu, action)?.enabled, action).toBe(false);
		}
		for (const top of ["Terminal", "Help"]) {
			expect(findItemByAction(findLabeledMenu(menu, top)?.submenu ?? [], MENU_ACTIONS.termCheatSheet)?.enabled, `cheat sheet under ${top}`).toBe(true);
		}
	});
});
