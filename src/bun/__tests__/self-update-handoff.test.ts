import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const tunnel = vi.hoisted(() => ({
	state: "idle" as "idle" | "starting" | "connected" | "failed",
	releaseMainTunnelForHandoff: vi.fn(() => null),
	stopMainTunnelForStableHandoff: vi.fn(() => null),
	stopTunnel: vi.fn(),
	getTunnelState: vi.fn(),
	startTunnel: vi.fn(async () => null as string | null),
	retryMainTunnel: vi.fn(),
	adoptMainTunnel: vi.fn(),
}));
vi.mock("../cloudflare-tunnel", () => tunnel);
vi.mock("../remote-access-server", () => ({ getServerPort: () => 43606 }));
vi.mock("../remote-state", async (importOriginal) => ({
	...(await importOriginal<typeof import("../remote-state")>()),
	readRemoteState: () => null,
	writeRemoteState: vi.fn(),
}));

import { _clearHandoff, _prepareHandoff } from "../self-update";

describe("an abandoned self-update gives the main tunnel back", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tunnel.getTunnelState.mockImplementation(() => tunnel.state);
	});

	it("restarts a tunnel it stopped while it was recovering, and keeps retrying if that fails", async () => {
		tunnel.state = "starting"; // a recovery placeholder: wanted, nothing to hand over
		const { handoff, stoppedWantedTunnel } = await _prepareHandoff("helper");
		expect(tunnel.stopTunnel).toHaveBeenCalled();
		expect(stoppedWantedTunnel).toBe(true);

		await _clearHandoff(handoff, stoppedWantedTunnel);
		expect(tunnel.startTunnel).toHaveBeenCalledWith(43606);
		expect(tunnel.retryMainTunnel).toHaveBeenCalledWith(43606);
	});

	it("leaves a box that had no tunnel without one", async () => {
		tunnel.state = "idle";
		const { handoff, stoppedWantedTunnel } = await _prepareHandoff("helper");
		expect(stoppedWantedTunnel).toBe(false);

		await _clearHandoff(handoff, stoppedWantedTunnel);
		expect(tunnel.startTunnel).not.toHaveBeenCalled();
		expect(tunnel.retryMainTunnel).not.toHaveBeenCalled();
	});

	it("keeps retrying a stable-hostname tunnel whose restart fails", async () => {
		tunnel.stopMainTunnelForStableHandoff.mockReturnValueOnce("https://box.example.com" as never);
		const { handoff, stoppedWantedTunnel } = await _prepareHandoff("helper");

		await _clearHandoff(handoff, stoppedWantedTunnel);
		expect(tunnel.startTunnel).toHaveBeenCalledWith(43606);
		expect(tunnel.retryMainTunnel).toHaveBeenCalledWith(43606);
	});
});
