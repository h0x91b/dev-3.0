import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isCloudflaredAvailable: vi.fn(),
	getTunnelState: vi.fn(),
	startTunnel: vi.fn(),
	stopTunnel: vi.fn(),
	getAccessUrl: vi.fn(),
	generateQrDataUrl: vi.fn(),
	getLocalInterfaces: vi.fn(),
	resolveAccessHost: vi.fn(),
	getServerPort: vi.fn(),
}));

vi.mock("../../cloudflare-tunnel", () => ({
	isCloudflaredAvailable: mocks.isCloudflaredAvailable,
	getTunnelState: mocks.getTunnelState,
	startTunnel: mocks.startTunnel,
	stopTunnel: mocks.stopTunnel,
}));

vi.mock("../../remote-access-server", () => ({
	getAccessUrl: mocks.getAccessUrl,
	generateQrDataUrl: mocks.generateQrDataUrl,
	getLocalInterfaces: mocks.getLocalInterfaces,
	resolveAccessHost: mocks.resolveAccessHost,
	getServerPort: mocks.getServerPort,
}));

import { remoteAccessHandlers, TUNNEL_DNS_SETTLE_DELAY_MS } from "../remote-access";

describe("remote access handler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.isCloudflaredAvailable.mockReturnValue(true);
		mocks.getTunnelState.mockReturnValue("idle");
		mocks.getServerPort.mockReturnValue(12478);
		mocks.startTunnel.mockResolvedValue("https://public.trycloudflare.com");
		mocks.generateQrDataUrl.mockResolvedValue("data:image/png;base64,test");
		mocks.getAccessUrl.mockResolvedValue("https://public.trycloudflare.com/?token=test");
		mocks.getLocalInterfaces.mockReturnValue([]);
		mocks.resolveAccessHost.mockReturnValue("127.0.0.1");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("auto-starts an installed Cloudflare tunnel and waits for DNS propagation", async () => {
		mocks.getTunnelState.mockReturnValueOnce("idle").mockReturnValue("connected");

		const resultPromise = remoteAccessHandlers.getRemoteAccessQR({});
		await vi.advanceTimersByTimeAsync(0);

		expect(mocks.startTunnel).toHaveBeenCalledWith(12478);
		expect(mocks.generateQrDataUrl).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(TUNNEL_DNS_SETTLE_DELAY_MS - 1);
		expect(mocks.generateQrDataUrl).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		const result = await resultPromise;
		expect(result.accessUrl).toBe("https://public.trycloudflare.com/?token=test");
		expect(mocks.generateQrDataUrl).toHaveBeenCalled();
	});

	it("keeps local access when the caller explicitly disables the tunnel", async () => {
		mocks.getAccessUrl.mockResolvedValue("http://192.168.0.1:12478/?token=test");

		const result = await remoteAccessHandlers.getRemoteAccessQR({ tunnel: false, host: "192.168.0.1" });

		expect(mocks.startTunnel).not.toHaveBeenCalled();
		expect(result.accessUrl).toBe("http://192.168.0.1:12478/?token=test");
		expect(mocks.generateQrDataUrl).toHaveBeenCalledWith("192.168.0.1");
	});
});
