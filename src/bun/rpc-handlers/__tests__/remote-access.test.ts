import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isTunnelBinaryAvailable: vi.fn(),
	getTunnelState: vi.fn(),
	startTunnel: vi.fn(),
	stopTunnel: vi.fn(),
	getAccessUrl: vi.fn(),
	generateQrDataUrl: vi.fn(),
	getLocalInterfaces: vi.fn(),
	resolveAccessHost: vi.fn(),
	getServerPort: vi.fn(),
	getRemoteAccessStatus: vi.fn(),
	retryRemoteAccessServer: vi.fn(),
	getStaticCode: vi.fn<() => string | null>(),
	getSignInLink: vi.fn<() => Promise<string | null>>(),
	resolveRemoteTunnelProvider: vi.fn(),
}));

vi.mock("../../tunnel-provider", () => ({
	resolveRemoteTunnelProvider: mocks.resolveRemoteTunnelProvider,
}));

vi.mock("../../cloudflare-tunnel", () => ({
	isTunnelBinaryAvailable: mocks.isTunnelBinaryAvailable,
	getTunnelState: mocks.getTunnelState,
	getMainTunnelFailureReason: () => null,
	startTunnel: mocks.startTunnel,
	stopTunnel: mocks.stopTunnel,
}));

vi.mock("../../remote-access-server", () => ({
	getAccessUrl: mocks.getAccessUrl,
	generateQrDataUrl: mocks.generateQrDataUrl,
	getLocalInterfaces: mocks.getLocalInterfaces,
	resolveAccessHost: mocks.resolveAccessHost,
	getServerPort: mocks.getServerPort,
	getRemoteAccessStatus: mocks.getRemoteAccessStatus,
	retryRemoteAccessServer: mocks.retryRemoteAccessServer,
	getStaticCode: mocks.getStaticCode,
	getSignInLink: mocks.getSignInLink,
}));

import { remoteAccessHandlers, TUNNEL_DNS_SETTLE_DELAY_MS } from "../remote-access";

describe("remote access handler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.isTunnelBinaryAvailable.mockReturnValue(true);
		mocks.getTunnelState.mockReturnValue("idle");
		mocks.getServerPort.mockReturnValue(12478);
		mocks.getRemoteAccessStatus.mockReturnValue({ running: true, port: 12478, failure: null });
		mocks.startTunnel.mockResolvedValue("https://public.trycloudflare.com");
		mocks.generateQrDataUrl.mockResolvedValue("data:image/png;base64,test");
		mocks.getAccessUrl.mockResolvedValue("https://public.trycloudflare.com/?token=test");
		mocks.getLocalInterfaces.mockReturnValue([]);
		mocks.resolveAccessHost.mockReturnValue("127.0.0.1");
		mocks.resolveRemoteTunnelProvider.mockReturnValue({ kind: "cloudflare", command: null, urlRegex: null });
		mocks.getStaticCode.mockReturnValue(null);
		mocks.getSignInLink.mockResolvedValue(null);
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

	it("reports the configured tunnel provider so the modal can adapt its copy", async () => {
		mocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			command: "my-tunnel {port}",
			urlRegex: /https:\/\/\S+/,
		});

		const result = await remoteAccessHandlers.getRemoteAccessQR({ tunnel: false });

		expect(result.tunnelProvider).toBe("custom");
		expect(result.tunnelBinaryInstalled).toBe(true);
	});

	// The modal must be able to say "a permanent code is set" without ever seeing
	// the code — reporting the value would put it in the renderer and in screenshots.
	it("reports whether a static access code is set, never the code itself", async () => {
		mocks.getStaticCode.mockReturnValue("sesame-open-up");
		const withCode = await remoteAccessHandlers.getRemoteAccessQR({ tunnel: false });
		expect(withCode.staticCodeActive).toBe(true);
		// The code itself travels only inside signInLink, which is copied on an
		// explicit click and never rendered — nothing else in the payload holds it.
		expect(JSON.stringify({ ...withCode, signInLink: null })).not.toContain("sesame-open-up");

		mocks.getStaticCode.mockReturnValue(null);
		const without = await remoteAccessHandlers.getRemoteAccessQR({ tunnel: false });
		expect(without.staticCodeActive).toBe(false);
		expect(without.signInLink).toBeNull();
	});

	// Nothing is listening means the port is 0, so a QR minted anyway would encode
	// http://host:0/ — scannable-looking and dead. The modal gets the status instead.
	it("mints no QR and no URL while the server never bound its port", async () => {
		mocks.getRemoteAccessStatus.mockReturnValue({
			running: false,
			port: 0,
			failure: { port: 45999, reason: "port-in-use", message: "Is port 45999 in use?" },
		});

		const result = await remoteAccessHandlers.getRemoteAccessQR({});

		expect(result.qrDataUrl).toBe("");
		expect(result.accessUrl).toBe("");
		expect(result.signInLink).toBeNull();
		expect(result.serverStatus.failure?.port).toBe(45999);
		expect(mocks.generateQrDataUrl).not.toHaveBeenCalled();
	});
});
