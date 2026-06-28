import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import AppMenuBar, { buildBrowserMenu } from "../AppMenuBar";
import type { MenuContext } from "../../../shared/application-menu";

const FULL: MenuContext = { hasTask: true, hasProject: true, hasTerminal: true };
const EMPTY: MenuContext = { hasTask: false, hasProject: false, hasTerminal: false };

type Node = ReturnType<typeof buildBrowserMenu>[number];

function topLabels(ctx: MenuContext): string[] {
	return buildBrowserMenu(ctx)
		.filter((n): n is Extract<Node, { kind: "submenu" }> => n.kind === "submenu")
		.map((n) => n.label);
}

function findItem(nodes: Node[], label: string): Extract<Node, { kind: "item" }> | undefined {
	for (const n of nodes) {
		if (n.kind === "item" && n.label === label) return n;
		if (n.kind === "submenu") {
			const hit = findItem(n.children, label);
			if (hit) return hit;
		}
	}
	return undefined;
}

describe("buildBrowserMenu", () => {
	it("drops native-only Edit and Window top-level menus", () => {
		const labels = topLabels(FULL);
		expect(labels).not.toContain("Edit");
		expect(labels).not.toContain("Window");
	});

	it("keeps the real action menus", () => {
		const labels = topLabels(FULL);
		for (const expected of ["dev-3.0", "File", "Task", "Project", "View", "Terminal", "Help"]) {
			expect(labels).toContain(expected);
		}
	});

	it("includes a browser-runnable item (New Task) and excludes roadmap items (Rename Task)", () => {
		const menu = buildBrowserMenu(FULL);
		expect(findItem(menu, "New Task")).toBeTruthy();
		// "Rename Task…" is on the roadmap (NOT_YET_IMPLEMENTED) → never listed.
		expect(findItem(menu, "Rename Task…")).toBeUndefined();
	});

	it("excludes native role items handled by the browser itself (no Quit/Paste)", () => {
		const menu = buildBrowserMenu(FULL);
		expect(findItem(menu, "Quit")).toBeUndefined();
		expect(findItem(menu, "Paste")).toBeUndefined();
	});

	it("greys context-gated items when their context is absent", () => {
		const full = buildBrowserMenu(FULL);
		const empty = buildBrowserMenu(EMPTY);
		// Reveal Worktree in Finder requires a task.
		expect(findItem(full, "Reveal Worktree in Finder")?.enabled).toBe(true);
		expect(findItem(empty, "Reveal Worktree in Finder")?.enabled).toBe(false);
		// Always-available item stays enabled regardless of context.
		expect(findItem(empty, "New Task")?.enabled).toBe(true);
	});
});

describe("AppMenuBar", () => {
	function renderBar(onAction = vi.fn()) {
		render(
			<I18nProvider>
				<AppMenuBar context={FULL} onAction={onAction} />
			</I18nProvider>,
		);
		return onAction;
	}

	it("renders a menubar with top-level menu buttons", () => {
		renderBar();
		expect(screen.getByRole("menubar")).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "File" })).toBeTruthy();
	});

	it("opens a dropdown on click and dispatches the action", async () => {
		const user = userEvent.setup();
		const onAction = renderBar();
		await user.click(screen.getByRole("menuitem", { name: "File" }));
		const newTask = await screen.findByRole("menuitem", { name: /New Task/ });
		await user.click(newTask);
		expect(onAction).toHaveBeenCalledWith("open-new-task");
	});

	it("does not dispatch when a disabled item is clicked", async () => {
		const user = userEvent.setup();
		const onAction = vi.fn();
		render(
			<I18nProvider>
				<AppMenuBar context={EMPTY} onAction={onAction} />
			</I18nProvider>,
		);
		// Project menu is present but its items are greyed without a project.
		await user.click(screen.getByRole("menuitem", { name: "Project" }));
		const pull = await screen.findByRole("menuitem", { name: /Pull main/ });
		await user.click(pull);
		expect(onAction).not.toHaveBeenCalled();
	});
});
