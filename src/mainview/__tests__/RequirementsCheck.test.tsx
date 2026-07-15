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
