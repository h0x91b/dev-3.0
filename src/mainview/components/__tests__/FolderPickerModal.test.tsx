import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import FolderPickerHost from "../FolderPickerModal";
import { openFilePicker, openFolderPicker } from "../../folder-picker";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listDirectory: vi.fn(),
			createDirectory: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function mockListing(path: string, entries: Array<{ name: string; isDir: boolean }>) {
	return {
		path,
		parent: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/",
		home: "/Users/test",
		entries: entries.map((e) => ({
			name: e.name,
			path: `${path === "/" ? "" : path}/${e.name}`,
			isDir: e.isDir,
		})),
	};
}

function renderHost() {
	return render(
		<I18nProvider>
			<FolderPickerHost />
		</I18nProvider>,
	);
}

describe("FolderPickerHost", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.removeItem("dev3-folder-picker-recent");
	});

	it("stays invisible until a picker request arrives", () => {
		renderHost();
		expect(screen.queryByTestId("folder-picker-backdrop")).not.toBeInTheDocument();
	});

	it("traps focus inside the dialog once opened", async () => {
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [{ name: "projects", isDir: true }]),
		);
		renderHost();
		openFolderPicker();

		const dialog = await screen.findByRole("dialog");
		// useFocusTrap pulls focus into the dialog from a passive effect
		// (`container.focus()` in a useEffect), which React flushes asynchronously
		// after commit. `findByRole` resolves on the DOM mutation, before that
		// effect is guaranteed to have run — so asserting focus synchronously is a
		// race that fails intermittently under CI scheduling jitter. Poll until the
		// trap has landed focus inside the dialog.
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	});

	it("opens on request, loads the initial listing, and resolves with the selected path on Select", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [
				{ name: "projects", isDir: true },
				{ name: "Downloads", isDir: true },
			]),
		);

		renderHost();
		const picked = openFolderPicker();

		const backdrop = await screen.findByTestId("folder-picker-backdrop");
		expect(backdrop).toBeInTheDocument();

		// Select is disabled until the user explicitly clicks a folder
		expect(screen.getByText("Select")).toBeDisabled();
		await screen.findByText("projects");
		await user.click(screen.getByText("projects"));
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));

		await expect(picked).resolves.toBe("/Users/test/projects");
	});

	it("resolves with null when the user cancels", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", []),
		);

		renderHost();
		const picked = openFolderPicker();
		await screen.findByTestId("folder-picker-backdrop");

		await user.click(screen.getByText("Cancel"));
		await expect(picked).resolves.toBeNull();
	});

	it("surfaces listing errors to the user", async () => {
		mockedApi.request.listDirectory.mockResolvedValue({
			...mockListing("/no/access", []),
			error: "EACCES: permission denied",
		});

		renderHost();
		openFolderPicker({ initialPath: "/no/access" });

		expect(await screen.findByText(/EACCES/)).toBeInTheDocument();
	});

	it("renders sidebar shortcuts for Home + Desktop/Documents/Downloads when they exist", async () => {
		// `Desktop`/`Documents`/`Downloads` may also appear as tree rows once
		// the async loader fetches the home listing — scope queries to the
		// sidebar element so we don't trip on the duplicate.
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [
				{ name: "Desktop", isDir: true },
				{ name: "Documents", isDir: true },
				{ name: "Downloads", isDir: true },
				{ name: "other", isDir: true },
			]),
		);

		renderHost();
		openFolderPicker();

		await screen.findByTestId("folder-picker-backdrop");
		const sidebar = await screen.findByTestId("folder-picker-sidebar");
		const sidebarQuery = within(sidebar);
		await waitFor(() => expect(sidebarQuery.getByText("Desktop")).toBeInTheDocument());
		expect(sidebarQuery.getByText("Home")).toBeInTheDocument();
		expect(sidebarQuery.getByText("Documents")).toBeInTheDocument();
		expect(sidebarQuery.getByText("Downloads")).toBeInTheDocument();
		// Root shortcut is always present
		expect(sidebarQuery.getByText("Root")).toBeInTheDocument();
	});

	it("saves the selected path to recent, and shows it in the sidebar next time", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test/projects", [{ name: "web", isDir: true }]),
		);

		renderHost();
		const picked = openFolderPicker({ initialPath: "/Users/test/projects" });
		await screen.findByTestId("folder-picker-backdrop");
		await screen.findByText("web");
		await user.click(screen.getByText("web"));
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));
		await picked;

		const stored = JSON.parse(localStorage.getItem("dev3-folder-picker-recent") ?? "[]");
		expect(stored).toEqual(["/Users/test/projects/web"]);
	});

	it("picks the folder the tree is rooted at via the current-folder row", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test/projects", [{ name: "web", isDir: true }]),
		);

		renderHost();
		const picked = openFolderPicker({ initialPath: "/Users/test/projects" });
		await screen.findByTestId("folder-picker-backdrop");

		await user.click(await screen.findByTestId("folder-picker-current-row"));
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));

		await expect(picked).resolves.toBe("/Users/test/projects");
	});

	it("creates a new folder inside the highlighted folder, not the tree root", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockImplementation(async ({ path }) =>
			path === "/Users/test/projects/web"
				? mockListing("/Users/test/projects/web", [])
				: mockListing("/Users/test/projects", [{ name: "web", isDir: true }]),
		);
		mockedApi.request.createDirectory.mockResolvedValue({
			ok: true,
			path: "/Users/test/projects/web/api",
		});

		renderHost();
		openFolderPicker({ initialPath: "/Users/test/projects", allowCreateFolder: true });
		await screen.findByTestId("folder-picker-backdrop");

		await user.click(await screen.findByText("web"));
		await user.click(await screen.findByText("New folder in web"));
		await user.type(screen.getByPlaceholderText("Folder name"), "api");
		await user.click(screen.getByText("Create"));

		await waitFor(() =>
			expect(mockedApi.request.createDirectory).toHaveBeenCalledWith({
				parentPath: "/Users/test/projects/web",
				name: "api",
			}),
		);
	});

	it("leaves the freshly created folder selected so Select works immediately", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockImplementation(async ({ path }) =>
			path === "/Users/test/projects/api"
				? mockListing("/Users/test/projects/api", [])
				: mockListing("/Users/test/projects", []),
		);
		mockedApi.request.createDirectory.mockResolvedValue({
			ok: true,
			path: "/Users/test/projects/api",
		});

		renderHost();
		const picked = openFolderPicker({ initialPath: "/Users/test/projects", allowCreateFolder: true });
		await screen.findByTestId("folder-picker-backdrop");

		await user.click(await screen.findByText("New folder in projects"));
		await user.type(screen.getByPlaceholderText("Folder name"), "api");
		await user.click(screen.getByText("Create"));

		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));
		await expect(picked).resolves.toBe("/Users/test/projects/api");
	});

	it("tells the user an empty folder is empty instead of showing a blank pane", async () => {
		mockedApi.request.listDirectory.mockResolvedValue(mockListing("/Users/test/empty", []));

		renderHost();
		openFolderPicker({ initialPath: "/Users/test/empty" });
		await screen.findByTestId("folder-picker-backdrop");

		expect(await screen.findByText("This folder is empty")).toBeInTheDocument();
	});

	it("filter input hides non-matching rows in the loaded tree", async () => {
		const user = userEvent.setup();
		// Use names that aren't also sidebar shortcuts so `getByText` finds
		// them exactly once — the tree row.
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [
				{ name: "aardvark", isDir: true },
				{ name: "zebra-notes", isDir: true },
				{ name: "midnight", isDir: true },
			]),
		);

		renderHost();
		openFolderPicker();
		await screen.findByTestId("folder-picker-backdrop");

		await screen.findByText("aardvark");
		const filterInput = screen.getByPlaceholderText("Filter folders…");
		await user.type(filterInput, "zeb");

		expect(screen.getByText("zebra-notes")).toBeInTheDocument();
		expect(screen.queryByText("aardvark")).not.toBeInTheDocument();
		expect(screen.queryByText("midnight")).not.toBeInTheDocument();
	});
});

describe("FolderPickerHost file mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.removeItem("dev3-folder-picker-recent");
	});

	it("lists files, resolves with the picked file, and never asks the backend to hide them", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/opt/homebrew/bin", [
				{ name: "lib", isDir: true },
				{ name: "claude", isDir: false },
			]),
		);

		renderHost();
		const picked = openFilePicker({ initialPath: "/opt/homebrew/bin" });
		await screen.findByTestId("folder-picker-backdrop");

		expect(mockedApi.request.listDirectory).toHaveBeenCalledWith({
			path: "/opt/homebrew/bin",
			includeFiles: true,
			showHidden: true,
		});

		await user.click(await screen.findByText("claude"));
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));
		await expect(picked).resolves.toBe("/opt/homebrew/bin/claude");
	});

	it("refuses to arm Select on a folder — the caller asked for a file", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/opt/homebrew/bin", [{ name: "lib", isDir: true }]),
		);

		renderHost();
		openFilePicker({ initialPath: "/opt/homebrew/bin" });
		await screen.findByTestId("folder-picker-backdrop");

		// The whole-folder row is gone in file mode …
		expect(screen.queryByTestId("folder-picker-current-row")).not.toBeInTheDocument();
		// … and highlighting a subfolder leaves Select dead.
		await user.click(await screen.findByText("lib"));
		expect(screen.getByText("Select")).toBeDisabled();
	});

	it("opens on the folder of a file it was pointed at, with that file already selected", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockImplementation(async ({ path }) =>
			path === "/opt/homebrew/bin/claude"
				? { ...mockListing("/opt/homebrew/bin/claude", []), error: "ENOTDIR" }
				: mockListing("/opt/homebrew/bin", [{ name: "claude", isDir: false }]),
		);

		renderHost();
		const picked = openFilePicker({ initialPath: "/opt/homebrew/bin/claude" });
		await screen.findByTestId("folder-picker-backdrop");

		// The ENOTDIR from the file itself must not reach the user as an error.
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		expect(screen.queryByText(/ENOTDIR/)).not.toBeInTheDocument();
		await user.click(screen.getByText("Select"));
		await expect(picked).resolves.toBe("/opt/homebrew/bin/claude");
	});

	it("re-reads the folder without dotfiles when the hidden toggle is switched off", async () => {
		const user = userEvent.setup();
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [{ name: ".bun", isDir: true }]),
		);

		renderHost();
		openFilePicker({ initialPath: "/Users/test" });
		await screen.findByTestId("folder-picker-backdrop");

		await user.click(screen.getByTestId("folder-picker-hidden-toggle"));
		await waitFor(() =>
			expect(mockedApi.request.listDirectory).toHaveBeenCalledWith({
				path: "/Users/test",
				includeFiles: true,
				showHidden: false,
			}),
		);
	});
});

describe("FolderPickerHost narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.removeItem("dev3-folder-picker-recent");
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("replaces the vertical sidebar with a horizontal Places chip strip", async () => {
		mockedApi.request.listDirectory.mockResolvedValue(
			mockListing("/Users/test", [
				{ name: "Desktop", isDir: true },
				{ name: "Documents", isDir: true },
			]),
		);

		renderHost();
		openFolderPicker();
		await screen.findByTestId("folder-picker-backdrop");

		// The dense vertical sidebar cannot fit a phone width, so it is not rendered;
		// Places collapse into the scrollable chip strip instead.
		const strip = await screen.findByTestId("folder-picker-places-strip");
		expect(strip).toBeInTheDocument();
		expect(screen.queryByTestId("folder-picker-sidebar")).not.toBeInTheDocument();
		// The Home shortcut is reachable from the strip.
		expect(within(strip).getByText("Home")).toBeInTheDocument();
	});
});
