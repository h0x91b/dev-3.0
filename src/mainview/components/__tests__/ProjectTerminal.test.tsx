import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectTerminal from "../ProjectTerminal";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getProjectPtyUrl: vi.fn().mockResolvedValue("ws://localhost:1234"),
			destroyProjectTerminal: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("../../TerminalView", () => ({
	default: () => <div data-testid="terminal-view" />,
}));

function renderTerminal(onBack = vi.fn()) {
	return {
		onBack,
		...render(
			<I18nProvider>
				<ProjectTerminal
					projectId="p1"
					projectPath="/home/user/project"
					onBack={onBack}
				/>
			</I18nProvider>,
		),
	};
}

describe("ProjectTerminal — back-to-board toolbar", () => {
	it("renders the back-to-board button", async () => {
		renderTerminal();
		expect(screen.getByText("Back to Board")).toBeInTheDocument();
	});

	it("renders the project path", async () => {
		renderTerminal();
		expect(screen.getByText("/home/user/project")).toBeInTheDocument();
	});

	it("renders the shortcut hint", async () => {
		renderTerminal();
		expect(screen.getByText("\u2318`")).toBeInTheDocument();
	});

	it("calls onBack when clicking the back button", async () => {
		const user = userEvent.setup();
		const { onBack } = renderTerminal();
		await user.click(screen.getByText("Back to Board"));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
