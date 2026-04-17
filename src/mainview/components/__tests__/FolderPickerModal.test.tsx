import { render, screen, waitFor } from "@testing-library/react";
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
});
