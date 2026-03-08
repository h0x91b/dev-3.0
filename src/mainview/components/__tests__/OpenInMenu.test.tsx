import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OpenInMenu from "../OpenInMenu";
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

function renderMenu(path = "/tmp/worktree", onClose = vi.fn()) {
	return {
		onClose,
		...render(
			<I18nProvider>
				<OpenInMenu position={{ top: 100, left: 200 }} path={path} onClose={onClose} />
			</I18nProvider>,
		),
	};
}

describe("OpenInMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset cached apps between tests
		vi.resetModules();
	});

	it("renders available apps", async () => {
		renderMenu();
		await waitFor(() => {
			expect(screen.getByText("Finder")).toBeInTheDocument();
			expect(screen.getByText("VS Code")).toBeInTheDocument();
			expect(screen.getByText("Cursor")).toBeInTheDocument();
		});
	});

	it("shows 'Open in...' header", async () => {
		renderMenu();
		await waitFor(() => {
			expect(screen.getByText("Open in...")).toBeInTheDocument();
		});
	});

	it("calls openInApp and closes menu when clicking an app", async () => {
		const onClose = vi.fn();
		renderMenu("/tmp/worktree", onClose);

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

	it("closes on Escape key", async () => {
		const onClose = vi.fn();
		renderMenu("/tmp/worktree", onClose);

		await waitFor(() => {
			expect(screen.getByText("Finder")).toBeInTheDocument();
		});

		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});
});
