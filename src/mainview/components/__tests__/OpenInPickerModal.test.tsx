import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenInPickerModal from "../OpenInPickerModal";
import { invalidateAvailableApps } from "../../hooks/useAvailableApps";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAvailableApps: vi.fn().mockResolvedValue([
				{ id: "finder", name: "Finder", macAppName: "Finder" },
				{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
				{ id: "cursor", name: "Cursor", macAppName: "Cursor" },
			]),
			openInApp: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

function renderModal(path = "/tmp/worktree", onClose = vi.fn()) {
	return {
		onClose,
		...render(
			<I18nProvider>
				<OpenInPickerModal path={path} onClose={onClose} />
			</I18nProvider>,
		),
	};
}

describe("OpenInPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		invalidateAvailableApps();
	});

	it("renders the available apps as a list", async () => {
		renderModal();
		await waitFor(() => {
			expect(screen.getByText("Finder")).toBeInTheDocument();
			expect(screen.getByText("VS Code")).toBeInTheDocument();
			expect(screen.getByText("Cursor")).toBeInTheDocument();
		});
	});

	it("shows the path being opened and the 'Open in...' title", async () => {
		renderModal("/tmp/my-worktree");
		expect(screen.getByText("Open in...")).toBeInTheDocument();
		expect(screen.getByText("/tmp/my-worktree")).toBeInTheDocument();
	});

	it("opens the clicked app for the given path and closes", async () => {
		const onClose = vi.fn();
		renderModal("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("VS Code")).toBeInTheDocument();
		});

		await userEvent.click(screen.getByText("VS Code"));

		expect(onClose).toHaveBeenCalled();
		await waitFor(() => {
			expect(mockedApi.request.openInApp).toHaveBeenCalledWith({
				appName: "Visual Studio Code",
				path: "/tmp/worktree",
			});
		});
	});

	it("opens the Nth visible row when its digit key is pressed", async () => {
		const onClose = vi.fn();
		renderModal("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("VS Code")).toBeInTheDocument();
		});

		// Row order is Finder(1), VS Code(2), Cursor(3) — from the search box, "2" opens VS Code.
		await userEvent.click(screen.getByRole("textbox"));
		await userEvent.keyboard("2");

		expect(onClose).toHaveBeenCalled();
		await waitFor(() => {
			expect(mockedApi.request.openInApp).toHaveBeenCalledWith({
				appName: "Visual Studio Code",
				path: "/tmp/worktree",
			});
		});
	});

	it("filters the list by typing and opens the match with Enter", async () => {
		const onClose = vi.fn();
		renderModal("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("Cursor")).toBeInTheDocument();
		});

		await userEvent.type(screen.getByRole("textbox"), "curs");

		expect(screen.getByText("Cursor")).toBeInTheDocument();
		expect(screen.queryByText("Finder")).not.toBeInTheDocument();
		expect(screen.queryByText("VS Code")).not.toBeInTheDocument();

		await userEvent.keyboard("{Enter}");

		expect(onClose).toHaveBeenCalled();
		await waitFor(() => {
			expect(mockedApi.request.openInApp).toHaveBeenCalledWith({ appName: "Cursor", path: "/tmp/worktree" });
		});
	});

	it("marks a user-added app with the custom badge", async () => {
		mockedApi.request.getAvailableApps.mockResolvedValueOnce([
			{ id: "finder", name: "Finder", macAppName: "Finder" },
			{ id: "textmate", name: "TextMate", macAppName: "TextMate" },
		]);
		invalidateAvailableApps();
		renderModal();

		await waitFor(() => {
			expect(screen.getByText("TextMate")).toBeInTheDocument();
		});
		// Finder is a built-in default; TextMate is user-added → exactly one badge.
		expect(screen.getAllByText("custom")).toHaveLength(1);
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		renderModal("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("Finder")).toBeInTheDocument();
		});

		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("closes when clicking the backdrop", async () => {
		const onClose = vi.fn();
		renderModal("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("Finder")).toBeInTheDocument();
		});

		// The dialog's backdrop is the outermost presentation element.
		const backdrop = screen.getByRole("presentation");
		await userEvent.click(backdrop);
		expect(onClose).toHaveBeenCalled();
	});

	it("copies the path to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

		renderModal("/tmp/my-worktree");
		await waitFor(() => {
			expect(screen.getByText("Copy Path")).toBeInTheDocument();
		});

		await userEvent.click(screen.getByText("Copy Path"));

		expect(writeText).toHaveBeenCalledWith("/tmp/my-worktree");
		expect(screen.getByText("Copied!")).toBeInTheDocument();
	});

	it("shows an empty state when no apps are installed", async () => {
		mockedApi.request.getAvailableApps.mockResolvedValueOnce([]);
		invalidateAvailableApps();
		renderModal();

		await waitFor(() => {
			expect(screen.getByText("No external apps found")).toBeInTheDocument();
		});
	});
});
