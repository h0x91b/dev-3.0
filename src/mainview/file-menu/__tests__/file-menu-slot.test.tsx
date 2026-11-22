import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExplorerEntry, ExplorerListing } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import FileExplorerFrame from "../../components/FileExplorerFrame";
import { _resetFileExplorerPrefs, setFileExplorerMode } from "../../file-explorer-prefs";
import { FILE_MENU_GROUPS, getFileMenuRegistry, type FileMenuItem, type FileMenuScope } from "../registry";
import { installFileMenuBuiltins } from "./install-builtins";

const shell = vi.hoisted(() => ({ desktop: false }));

vi.mock("../../rpc", () => ({
	get isElectrobun() {
		return shell.desktop;
	},
	api: { request: { listExplorerDirectory: vi.fn(), openTerminalPath: vi.fn(), openFileBrowser: vi.fn() } },
}));

import { api } from "../../rpc";

const entry = (relPath: string, kind: ExplorerEntry["kind"]): ExplorerEntry => ({ name: relPath.split("/").pop()!, path: `/wt/${relPath}`, relPath, kind, ignored: false });
const TREE: Record<string, ExplorerEntry[]> = { "": [entry("src", "directory"), entry("README.md", "file")], src: [] };

function renderExplorer() {
	render(
		<I18nProvider>
			<FileExplorerFrame projectId="p1" taskId="t1" rootLabel="feat/x" enabled>
				<div data-testid="terminal" />
			</FileExplorerFrame>
		</I18nProvider>,
	);
}

async function openMenu(name: RegExp): Promise<HTMLElement> {
	fireEvent.contextMenu(await screen.findByRole("treeitem", { name }));
	return screen.getByRole("menu");
}

/** Row labels per section, in document order. */
function sections(menu: HTMLElement): string[][] {
	return within(menu).getAllByRole("group").map((group) => within(group).getAllByRole("menuitem").map((item) => item.textContent ?? ""));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function contribute(name: string, items: FileMenuItem[]) {
	const fiber = getAppRoot().plugin({
		name,
		inject: ["fileMenu"],
		apply(ctx) {
			for (const item of items) ctx.fileMenu.register(item);
		},
	});
	await settle();
	return fiber;
}

beforeEach(async () => {
	await installFileMenuBuiltins();
	vi.mocked(api.request.listExplorerDirectory).mockImplementation(async ({ relPath }: { relPath?: string }) => ({ root: "/wt", relPath: relPath ?? "", entries: TREE[relPath ?? ""] ?? [] }) satisfies ExplorerListing);
	localStorage.removeItem("dev3-file-explorer");
	_resetFileExplorerPrefs();
	setFileExplorerMode("pinned");
});

afterEach(() => {
	shell.desktop = false;
});

describe("fileMenu slot", () => {
	it("is a contribution slot whose built-ins each name a known group", () => {
		const registry = getFileMenuRegistry();
		expect(registry.kind).toBe("contribute");
		for (const { def } of registry.list()) {
			expect(def.id.startsWith("builtin:")).toBe(true);
			expect(FILE_MENU_GROUPS).toContain(def.region);
		}
	});

	it("draws the built-in rows in their sections: a file gets preview, a folder does not, and the host rows only in the desktop shell", async () => {
		renderExplorer();
		expect(sections(await openMenu(/README\.md/))).toEqual([["Open preview"], ["Insert path in terminal", "Copy relative path", "Copy path"]]);
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		expect(sections(await openMenu(/^src/))).toEqual([["Insert path in terminal", "Copy relative path", "Copy path"]]);
	});

	it("in the desktop shell adds open-with-system and reveal, which open on the host", async () => {
		shell.desktop = true;
		renderExplorer();
		const menu = await openMenu(/README\.md/);
		const host = sections(menu)[2];
		expect(host[0]).toBe("Open with system app");
		expect(host[1]).toMatch(/^Reveal in (Finder|Explorer|file manager)$/);
		await userEvent.click(within(menu).getByRole("menuitem", { name: host[1] }));
		expect(api.request.openTerminalPath).toHaveBeenCalledWith({ path: "/wt/README.md", mode: "reveal" });
	});

	it("puts a non-built-in item into one trailing section and hands it the row's scope", async () => {
		const run = vi.fn();
		await contribute("acme", [{ id: "acme:stat", region: "open", order: -1, label: ({ entry }) => `Stat ${entry.name}`, run }]);
		renderExplorer();
		const menu = await openMenu(/README\.md/);
		expect(sections(menu).slice(-1)[0]).toEqual(["Stat README.md"]);
		expect(sections(menu)[0]).toEqual(["Open preview"]);
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Stat README.md" }));
		expect(screen.queryByRole("menu")).toBeNull();
		const scope = run.mock.calls[0][0] as FileMenuScope;
		expect(scope).toMatchObject({ entry: { relPath: "README.md" }, inPrimaryRoot: true, projectId: "p1", taskId: "t1" });
	});

	it("listens to the fileMenu slot only while a row menu is open", async () => {
		const subscribe = vi.spyOn(getFileMenuRegistry(), "subscribe");
		renderExplorer();
		await screen.findByRole("treeitem", { name: /README\.md/ });
		expect(subscribe).not.toHaveBeenCalled();
		await openMenu(/README\.md/);
		expect(subscribe).toHaveBeenCalledTimes(1);
		subscribe.mockRestore();
	});

	it("[dispose] drops a plugin's rows from the open menu when the plugin unloads, keeping the explorer's", async () => {
		const fiber = await contribute("acme", [{ id: "acme:x", region: "open", label: () => "Acme row", run: () => {} }]);
		renderExplorer();
		const menu = await openMenu(/README\.md/);
		expect(sections(menu).slice(-1)[0]).toEqual(["Acme row"]);
		await act(async () => {
			await fiber.dispose();
		});
		expect(getFileMenuRegistry().get("acme:x")).toBeUndefined();
		// The trailing section goes with its last row: no dangling rule.
		expect(sections(screen.getByRole("menu"))).toEqual([["Open preview"], ["Insert path in terminal", "Copy relative path", "Copy path"]]);
		expect(screen.getByTestId("terminal")).toBeInTheDocument();
	});
});
