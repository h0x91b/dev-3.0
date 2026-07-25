import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionStatusPill from "../ConnectionStatusPill";
import { I18nProvider } from "../../i18n";
import { RPC_STATUS_EVENT, type RpcConnectionState } from "../../diagnostics";
import { isRemote } from "../../utils/platform";
import { reconnectRpc } from "../../rpc";

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

function renderPill() {
	render(
		<I18nProvider>
			<ConnectionStatusPill />
		</I18nProvider>,
	);
}

function emitState(state: RpcConnectionState) {
	act(() => {
		window.dispatchEvent(new CustomEvent(RPC_STATUS_EVENT, { detail: { state } }));
	});
}

beforeEach(() => {
	isRemoteMock.mockReturnValue(true);
	vi.mocked(reconnectRpc).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ConnectionStatusPill", () => {
	it("renders nothing while the transport is healthy", () => {
		renderPill();
		expect(screen.queryByTestId("connection-status-pill")).not.toBeInTheDocument();
	});

	it("renders nothing on desktop even when the transport drops", () => {
		isRemoteMock.mockReturnValue(false);
		renderPill();
		emitState("reconnecting");
		expect(screen.queryByTestId("connection-status-pill")).not.toBeInTheDocument();
	});

	it("names the unhealthy state and offers a retry", () => {
		renderPill();
		emitState("reconnecting");
		expect(screen.getByTestId("connection-status-pill")).toHaveTextContent("Reconnecting");
		emitState("closed");
		expect(screen.getByTestId("connection-status-pill")).toHaveTextContent("Disconnected");
	});

	it("stays silent for auth-failed — the scan-QR screen owns that state", () => {
		renderPill();
		emitState("auth-failed");
		expect(screen.queryByTestId("connection-status-pill")).not.toBeInTheDocument();
	});

	it("reconnects the transport when tapped", async () => {
		const user = userEvent.setup();
		renderPill();
		emitState("reconnecting");
		await user.click(screen.getByTestId("connection-status-pill"));
		expect(reconnectRpc).toHaveBeenCalledTimes(1);
	});

	it("confirms recovery, then disappears", () => {
		vi.useFakeTimers();
		renderPill();
		emitState("reconnecting");
		emitState("connected");
		expect(screen.getByTestId("connection-status-pill")).toHaveTextContent("Back online");
		act(() => vi.advanceTimersByTime(3_000));
		expect(screen.queryByTestId("connection-status-pill")).not.toBeInTheDocument();
	});
});
