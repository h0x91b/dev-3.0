import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerEntry, ExplorerListing } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

const shell = vi.hoisted(() => ({ desktop: false }));

vi.mock("../../rpc", () => ({
	get isElectrobun() {
		return shell.desktop;
	},
	api: {
		request: {
			listExplorerDirectory: vi.fn(),
			openTerminalPath: vi.fn(),
			openFileBrowser: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";
import FileExplorerFrame from "../FileExplorerFrame";
import { quoteForShell } from "../FileExplorer";
import { OPEN_FILE_PREVIEW_EVENT } from "../../terminal-path-open";
import {
	_resetFileExplorerPrefs,
	getFileExplorerPrefs,
	REVEAL_FILE_EXPLORER_EVENT,
	setFileExplorerMode,
	toggleFileExplorer,
} from "../../file-explorer-prefs";

const mockedApi = vi.mocked(api, true);

function entry(relPath: string, kind: ExplorerEntry["kind"], ignored = false): ExplorerEntry {
	return { name: relPath.split("/").pop()!, path: `/wt/${relPath}`, relPath, kind, ignored };
}

const TREE: Record<string, ExplorerEntry[]> = {
	"": [entry("src", "directory"), entry("node_modules", "directory", true), entry("README.md", "file")],
	src: [entry("src/index.ts", "file"), entry("src/lib", "directory")],
	"src/lib": [entry("src/lib/util.ts", "file")],
	node_modules: [entry("node_modules/react", "directory")],
};

function serveTree() {
	mockedApi.request.listExplorerDirectory.mockImplementation(async ({ relPath }: { relPath?: string }) => {
		const rel = relPath ?? "";
		return { root: "/wt", relPath: rel, entries: TREE[rel] ?? [] } satisfies ExplorerListing;
	});
}

let mounts = 0;
function FakeTerminal() {
	useEffect(() => {
		mounts += 1;
	}, []);
	return <div data-testid="fake-terminal">terminal</div>;
}

function renderFrame(taskId: string | null = "task-1") {
	return render(
		<I18nProvider>
			<FileExplorerFrame projectId="proj-1" taskId={taskId} rootLabel="feat/branch" enabled>
				<FakeTerminal />
			</FileExplorerFrame>
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.removeItem("dev3-file-explorer");
	_resetFileExplorerPrefs();
	mounts = 0;
	serveTree();
});

afterEach(() => {
	localStorage.removeItem("dev3-file-explorer");
});

describe("file explorer preferences", () => {
	it("starts hidden; the toggle shows it pinned, then hides it again", () => {
		expect(getFileExplorerPrefs().mode).toBe("hidden");
		toggleFileExplorer();
		expect(getFileExplorerPrefs().mode).toBe("pinned");
		toggleFileExplorer();
		expect(getFileExplorerPrefs().mode).toBe("hidden");
	});

	it("returns to auto-hide when that was the last visible mode, and persists it", () => {
		setFileExplorerMode("autohide");
		setFileExplorerMode("hidden");
		toggleFileExplorer();
		expect(getFileExplorerPrefs().mode).toBe("autohide");
		_resetFileExplorerPrefs();
		expect(getFileExplorerPrefs().mode).toBe("autohide");
	});

	it("asks an auto-hidden panel to slide in instead of changing mode", () => {
		setFileExplorerMode("autohide");
		const onReveal = vi.fn();
		window.addEventListener(REVEAL_FILE_EXPLORER_EVENT, onReveal);
		toggleFileExplorer();
		window.removeEventListener(REVEAL_FILE_EXPLORER_EVENT, onReveal);
		expect(onReveal).toHaveBeenCalledTimes(1);
		expect(getFileExplorerPrefs().mode).toBe("autohide");
	});
});

describe("FileExplorerFrame", () => {
	it("never remounts the content when the mode changes", async () => {
		renderFrame();
		expect(mounts).toBe(1);
		act(() => setFileExplorerMode("pinned"));
		await screen.findByTestId("file-explorer-pinned");
		act(() => setFileExplorerMode("autohide"));
		await screen.findByTestId("file-explorer-rail");
		act(() => setFileExplorerMode("hidden"));
		expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
		expect(mounts).toBe(1);
	});

	it("auto-hide shows only a rail; clicking it slides the tree over the content", async () => {
		setFileExplorerMode("autohide");
		renderFrame();
		expect(screen.queryByRole("tree")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Show files" }));
		expect(await screen.findByTestId("file-explorer-overlay")).toBeInTheDocument();
		expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeInTheDocument();
	});

	it("lists the root with ignored entries dimmed and loads a folder on expand", async () => {
		setFileExplorerMode("pinned");
		renderFrame();
		const ignored = await screen.findByRole("treeitem", { name: /node_modules/ });
		expect(ignored.className).toContain("text-fg-muted");
		expect(mockedApi.request.listExplorerDirectory).toHaveBeenCalledWith({ projectId: "proj-1", taskId: "task-1", relPath: "", insideIgnored: false });

		await userEvent.click(screen.getByRole("treeitem", { name: /^src/ }));
		expect(await screen.findByRole("treeitem", { name: /index\.ts/ })).toBeInTheDocument();
		expect(screen.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-expanded", "true");
	});

	it("shows long names in full and scrolls the tree sideways instead of truncating", async () => {
		setFileExplorerMode("pinned");
		renderFrame();
		const name = await screen.findByText("README.md");
		expect(name.className).not.toContain("truncate");
		expect(name.className).toContain("whitespace-nowrap");
		expect(screen.getByRole("tree").firstElementChild?.className).toContain("w-max");
	});

	it("opens a clicked file in the in-app preview", async () => {
		setFileExplorerMode("pinned");
		const onPreview = vi.fn();
		window.addEventListener(OPEN_FILE_PREVIEW_EVENT, onPreview);
		renderFrame();
		await userEvent.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
		window.removeEventListener(OPEN_FILE_PREVIEW_EVENT, onPreview);
		expect((onPreview.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ path: "/wt/README.md", taskId: "task-1" });
	});

	it("inserts a relative path into the task terminal from the context menu", async () => {
		setFileExplorerMode("pinned");
		const onPaste = vi.fn();
		window.addEventListener("dev3:requestTerminalPaste", onPaste);
		renderFrame();
		fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /README\.md/ }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Insert path in terminal" }));
		window.removeEventListener("dev3:requestTerminalPaste", onPaste);
		expect((onPaste.mock.calls[0][0] as CustomEvent).detail).toEqual({ target: "task-1", text: "README.md " });
	});

	it("on the Repo screen inserts into the project terminal, and offers no host-side open in a browser", async () => {
		setFileExplorerMode("pinned");
		const onPaste = vi.fn();
		window.addEventListener("dev3:requestTerminalPaste", onPaste);
		renderFrame(null);
		fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /README\.md/ }));
		const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
		expect(labels).toEqual(["Open preview", "Insert path in terminal", "Copy relative path", "Copy path"]);
		expect(screen.getByTestId("file-explorer-menu-title")).toHaveTextContent("README.md");
		await userEvent.click(screen.getByRole("menuitem", { name: "Insert path in terminal" }));
		window.removeEventListener("dev3:requestTerminalPaste", onPaste);
		expect((onPaste.mock.calls[0][0] as CustomEvent).detail).toEqual({ target: "project-proj-1", text: "README.md " });
	});

	it("dims everything inside an ignored folder and lists it without asking git", async () => {
		setFileExplorerMode("pinned");
		renderFrame("task-ignored");
		await userEvent.click(await screen.findByRole("treeitem", { name: /node_modules/ }));
		const child = await screen.findByRole("treeitem", { name: /react/ });
		expect(child.className).toContain("text-fg-muted");
		expect(mockedApi.request.listExplorerDirectory).toHaveBeenCalledWith(expect.objectContaining({ relPath: "node_modules", insideIgnored: true }));
	});

	it("polls only folders on screen and forgets one that was deleted", async () => {
		setFileExplorerMode("pinned");
		// Its own root: expanded folders are remembered per root for the session.
		renderFrame("task-poll");
		await userEvent.click(await screen.findByRole("treeitem", { name: /^src/ }));
		await userEvent.click(await screen.findByRole("treeitem", { name: /lib/ }));
		await screen.findByRole("treeitem", { name: /util\.ts/ });
		// Collapse src: its open child lib is no longer on screen.
		await userEvent.click(screen.getByRole("treeitem", { name: /^src/ }));
		mockedApi.request.listExplorerDirectory.mockClear();
		act(() => { window.dispatchEvent(new Event("focus")); });
		await waitFor(() => expect(mockedApi.request.listExplorerDirectory).toHaveBeenCalled());
		const polled = mockedApi.request.listExplorerDirectory.mock.calls.map(([params]) => params.relPath);
		expect(polled).toEqual([""]);

		// src is deleted while expanded: the next listing drops it from the open set.
		await userEvent.click(screen.getByRole("treeitem", { name: /^src/ }));
		mockedApi.request.listExplorerDirectory.mockImplementation(async ({ relPath }: { relPath?: string }) => (
			relPath === "src"
				? { root: "/wt", relPath: "src", entries: [], error: "not-found" }
				: { root: "/wt", relPath: relPath ?? "", entries: TREE[relPath ?? ""] ?? [] }
		) satisfies ExplorerListing);
		act(() => { window.dispatchEvent(new Event("focus")); });
		await waitFor(() => expect(screen.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-expanded", "false"));
	});

	it("walks the tree with the arrow keys", async () => {
		setFileExplorerMode("pinned");
		renderFrame();
		await screen.findByRole("treeitem", { name: /README\.md/ });
		const tree = screen.getByRole("tree");
		tree.focus();
		await userEvent.keyboard("{ArrowDown}{ArrowRight}");
		await waitFor(() => expect(screen.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-expanded", "true"));
		await screen.findByRole("treeitem", { name: /index\.ts/ });
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByRole("treeitem", { name: /index\.ts/ })).toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{ArrowLeft}");
		expect(screen.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-selected", "true");
	});

	it("shows the no-root message when there is no folder to list", async () => {
		setFileExplorerMode("pinned");
		mockedApi.request.listExplorerDirectory.mockResolvedValue({ root: "", relPath: "", entries: [], error: "no-root" });
		renderFrame(null);
		expect(await screen.findByText("There is no folder to show here.")).toBeInTheDocument();
	});
});

describe("Escape inside the explorer", () => {
	it("closes an auto-hidden panel without reaching the app's Escape", async () => {
		setFileExplorerMode("autohide");
		const appEscape = vi.fn();
		window.addEventListener("keydown", appEscape);
		renderFrame();
		await userEvent.click(screen.getByRole("button", { name: "Show files" }));
		await screen.findByRole("treeitem", { name: /README\.md/ });
		await userEvent.keyboard("{Escape}");
		window.removeEventListener("keydown", appEscape);
		expect(screen.queryByTestId("file-explorer-overlay")).not.toBeInTheDocument();
		expect(appEscape).not.toHaveBeenCalled();
	});

	it("leaves a pinned tree without reaching the app's Escape", async () => {
		setFileExplorerMode("pinned");
		const appEscape = vi.fn();
		window.addEventListener("keydown", appEscape);
		renderFrame();
		await screen.findByRole("treeitem", { name: /README\.md/ });
		screen.getByRole("tree").focus();
		await userEvent.keyboard("{Escape}");
		window.removeEventListener("keydown", appEscape);
		expect(appEscape).not.toHaveBeenCalled();
		expect(screen.getByRole("tree")).not.toHaveFocus();
	});
});

describe("auto-hide hand-off", () => {
	it("slides the panel away after inserting a path into the terminal", async () => {
		setFileExplorerMode("autohide");
		renderFrame();
		await userEvent.click(screen.getByRole("button", { name: "Show files" }));
		fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /README\.md/ }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Insert path in terminal" }));
		expect(screen.queryByTestId("file-explorer-overlay")).not.toBeInTheDocument();
	});
});

describe("explorer header", () => {
	it("shows the root folder's full path, streamer-masked, when hovering the label", async () => {
		setFileExplorerMode("pinned");
		renderFrame();
		await screen.findByRole("treeitem", { name: /README\.md/ });
		await userEvent.hover(screen.getByText("feat/branch"));
		const tip = await screen.findByRole("tooltip");
		expect(tip).toHaveTextContent("/wt");
		expect(screen.getByTestId("file-explorer-root-path")).toHaveClass("streamer-private");
	});
});

describe("explorer header menu", () => {
	it("offers the root folder's path and hiding, with yazi only where it is wired", async () => {
		setFileExplorerMode("pinned");
		renderFrame();
		await screen.findByRole("treeitem", { name: /README\.md/ });
		await userEvent.click(screen.getByRole("button", { name: "More actions" }));
		const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
		// Browser mode: no host-side "Open in Finder".
		expect(labels).toEqual(["Copy folder path", "Hide explorer"]);
	});

	it("in the desktop shell opens the root folder in the file manager", async () => {
		shell.desktop = true;
		try {
			setFileExplorerMode("pinned");
			renderFrame();
			await screen.findByRole("treeitem", { name: /README\.md/ });
			await userEvent.click(screen.getByRole("button", { name: "More actions" }));
			const first = screen.getAllByRole("menuitem")[0];
			expect(first.textContent).toMatch(/^Open (in Finder|in Explorer|folder in file manager)$/);
			await userEvent.click(first);
			expect(mockedApi.request.openTerminalPath).toHaveBeenCalledWith({ path: "/wt", mode: "system" });
		} finally {
			shell.desktop = false;
		}
	});
});

describe("quoteForShell", () => {
	it("leaves plain paths alone and quotes anything a shell would read", () => {
		expect(quoteForShell("src/app/index.ts")).toBe("src/app/index.ts");
		expect(quoteForShell("src/components/a;b.tsx")).toBe("'src/components/a;b.tsx'");
		expect(quoteForShell("src/(old).tsx")).toBe("'src/(old).tsx'");
		expect(quoteForShell("my file.md")).toBe("'my file.md'");
		expect(quoteForShell("it's.md")).toBe("'it'\\''s.md'");
	});

	it("never passes a control byte through, so a file name cannot end the terminal's bracketed paste", () => {
		const quoted = quoteForShell("evil\u001b[201~; rm -rf ~\r.md");
		expect(quoted).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		// Each control byte becomes an unquoted `?`, which a POSIX shell still globs to the real file.
		expect(quoted).toBe("evil?'[201~; rm -rf ~'?.md");
		expect(quoteForShell("a\u0007b\u009bc")).toBe("a?b?c");
	});
});
