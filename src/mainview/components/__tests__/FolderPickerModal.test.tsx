import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FolderPickerHost from "../FolderPickerModal";
import { openFolderPicker } from "../../folder-picker";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listDirectory: vi.fn(),
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

		// The initial home path is pre-selected
		await waitFor(() => {
			expect(screen.getByText("Select")).not.toBeDisabled();
		});
		await user.click(screen.getByText("Select"));

		await expect(picked).resolves.toBe("/Users/test");
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
		await waitFor(() => expect(screen.getByText("Select")).not.toBeDisabled());
		await user.click(screen.getByText("Select"));
		await picked;

		const stored = JSON.parse(localStorage.getItem("dev3-folder-picker-recent") ?? "[]");
		expect(stored).toEqual(["/Users/test/projects"]);
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
