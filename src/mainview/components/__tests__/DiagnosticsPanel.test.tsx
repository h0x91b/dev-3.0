import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiagnosticsPanel from "../DiagnosticsPanel";
import { I18nProvider } from "../../i18n";
import { __resetDiagnosticsForTests, recordDiagnostic, recordError } from "../../diagnostics";

// hooks/useDiagnostics imports the transport for useRpcStatus — stub it so no
// real WebSocket is opened during the test.
vi.mock("../../rpc", () => ({
	isElectrobun: false,
	getRpcConnectionState: () => "connected",
	reconnectRpc: vi.fn(),
	api: { request: {} },
}));

function renderPanel(onClose = vi.fn()) {
	render(
		<I18nProvider>
			<DiagnosticsPanel onClose={onClose} />
		</I18nProvider>,
	);
	return { onClose };
}

beforeEach(() => {
	__resetDiagnosticsForTests();
});

describe("DiagnosticsPanel", () => {
	it("shows the empty state when nothing was captured", () => {
		renderPanel();
		expect(screen.getByText(/No issues captured/i)).toBeInTheDocument();
	});

	it("lists captured entries newest-first", () => {
		recordError("older error");
		recordDiagnostic({ kind: "rpc", level: "error", message: "newer error" });
		renderPanel();
		const entries = screen.getAllByTestId("diagnostic-entry");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toHaveTextContent("newer error");
		expect(entries[1]).toHaveTextContent("older error");
	});

	it("updates live as new diagnostics arrive", () => {
		renderPanel();
		expect(screen.queryByTestId("diagnostic-entry")).not.toBeInTheDocument();
		act(() => recordError("late error"));
		expect(screen.getByText("late error")).toBeInTheDocument();
	});

	it("clears all entries on Clear", async () => {
		recordError("to be cleared");
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Clear" }));
		expect(screen.queryByText("to be cleared")).not.toBeInTheDocument();
		expect(screen.getByText(/No issues captured/i)).toBeInTheDocument();
	});

	it("closes on the close button", async () => {
		const user = userEvent.setup();
		const { onClose } = renderPanel();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
