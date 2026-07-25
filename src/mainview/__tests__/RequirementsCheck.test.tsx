import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RequirementsCheck from "../components/RequirementsCheck";
import { I18nProvider } from "../i18n";
import { api } from "../rpc";

vi.mock("../rpc", () => ({
	api: {
		request: {
			setCustomBinaryPath: vi.fn(),
		},
	},
}));

const missingTmux = {
	id: "tmux",
	name: "tmux",
	installed: false,
	installHint: "requirements.installTmux",
	installCommand: "brew install h0x91b/dev3/tmux@3.6",
	brewInstallable: true,
	customPathError: false,
};

function renderCheck(onRefreshResults = vi.fn(async () => undefined)) {
	render(
		<I18nProvider>
			<RequirementsCheck
				results={[missingTmux] as any}
				checking={false}
				onRefresh={() => {}}
				onRefreshResults={onRefreshResults}
			/>
		</I18nProvider>,
	);
	return { onRefreshResults };
}

describe("RequirementsCheck custom binary path", () => {
	beforeEach(() => vi.clearAllMocks());

	it("shows an inline error and restores input focus when the backend rejects a path", async () => {
		vi.mocked(api.request.setCustomBinaryPath).mockResolvedValue({ ok: false });
		const user = userEvent.setup();
		const { onRefreshResults } = renderCheck();
		const input = screen.getByRole("textbox");

		await user.type(input, "/Users/tester");
		await user.click(screen.getByRole("button", { name: "Set path" }));

		expect(await screen.findByText("Path must point to an executable tmux binary")).toBeInTheDocument();
		expect(input).toHaveFocus();
		expect(onRefreshResults).not.toHaveBeenCalled();
	});

	it("refreshes requirements only after a path is validated and saved", async () => {
		vi.mocked(api.request.setCustomBinaryPath).mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const { onRefreshResults } = renderCheck();

		await user.type(screen.getByRole("textbox"), "/opt/homebrew/bin/tmux");
		await user.click(screen.getByRole("button", { name: "Set path" }));

		await waitFor(() => expect(onRefreshResults).toHaveBeenCalledOnce());
		expect(screen.queryByText("Path must point to an executable tmux binary")).not.toBeInTheDocument();
	});
});

// On Windows tmux has no install command at all — it cannot be installed there.
// The copy-command block must disappear rather than render an empty code box,
// while the custom-path row (the only actionable control left) stays.
describe("RequirementsCheck without an install command", () => {
	beforeEach(() => vi.clearAllMocks());

	const windowsTmux = {
		id: "tmux",
		name: "tmux",
		installed: false,
		installHint: "requirements.tmuxUnavailableWindows",
		brewInstallable: false,
		optional: true,
		customPathError: false,
	};

	function renderWindows() {
		render(
			<I18nProvider>
				<RequirementsCheck
					results={[windowsTmux] as any}
					checking={false}
					onRefresh={() => {}}
					onRefreshResults={vi.fn(async () => undefined)}
				/>
			</I18nProvider>,
		);
	}

	it("still explains why the tool is missing", () => {
		renderWindows();
		expect(screen.getByText(/Not available on Windows/i)).toBeInTheDocument();
	});

	it("renders no copy-to-clipboard button when there is nothing to copy", () => {
		renderWindows();
		expect(screen.queryByTitle("Copy")).not.toBeInTheDocument();
	});

	it("keeps the manual binary-path input available", () => {
		renderWindows();
		expect(screen.getByPlaceholderText("/path/to/tmux")).toBeInTheDocument();
	});

	it("still shows the copy button for a requirement that HAS a command", () => {
		renderCheck();
		expect(screen.getByTitle("Copy")).toBeInTheDocument();
		expect(screen.getByText("brew install h0x91b/dev3/tmux@3.6")).toBeInTheDocument();
	});
});
