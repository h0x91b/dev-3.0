import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiagnosticsIndicator from "../DiagnosticsIndicator";
import { I18nProvider } from "../../i18n";
import { DIAGNOSTICS_OPEN_EVENT, __resetDiagnosticsForTests, recordError } from "../../diagnostics";
import { isRemote } from "../../utils/platform";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	getRpcConnectionState: () => "connected",
	reconnectRpc: vi.fn(),
	api: { request: {} },
}));

vi.mock("../../utils/platform", () => ({
	isRemote: vi.fn(() => true),
	isMac: vi.fn(() => true),
}));

const isRemoteMock = vi.mocked(isRemote);

function renderIndicator() {
	render(
		<I18nProvider>
			<DiagnosticsIndicator />
		</I18nProvider>,
	);
}

beforeEach(() => {
	__resetDiagnosticsForTests();
	isRemoteMock.mockReturnValue(true);
});

describe("DiagnosticsIndicator", () => {
	it("renders nothing when there are no errors", () => {
		renderIndicator();
		expect(screen.queryByTestId("diagnostics-indicator")).not.toBeInTheDocument();
	});

	it("renders nothing on desktop even when errors exist", () => {
		isRemoteMock.mockReturnValue(false);
		recordError("boom");
		renderIndicator();
		expect(screen.queryByTestId("diagnostics-indicator")).not.toBeInTheDocument();
	});

	it("shows the error count in remote mode and updates live", () => {
		renderIndicator();
		expect(screen.queryByTestId("diagnostics-indicator")).not.toBeInTheDocument();
		act(() => recordError("boom"));
		const pill = screen.getByTestId("diagnostics-indicator");
		expect(pill).toHaveTextContent("1 issue");
		act(() => recordError("bang"));
		expect(pill).toHaveTextContent("2 issues");
	});

	it("dispatches the open-diagnostics event when tapped", async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		window.addEventListener(DIAGNOSTICS_OPEN_EVENT, onOpen);
		recordError("boom");
		renderIndicator();
		await user.click(screen.getByTestId("diagnostics-indicator"));
		expect(onOpen).toHaveBeenCalledTimes(1);
		window.removeEventListener(DIAGNOSTICS_OPEN_EVENT, onOpen);
	});
});
