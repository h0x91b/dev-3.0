import { getAccessUrl, generateQrDataUrl } from "../remote-access-server";

async function getRemoteAccessQR(params: { tunnel?: boolean }): Promise<{ qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean }> {
	const { isCloudflaredAvailable, getTunnelState, startTunnel } = await import("../cloudflare-tunnel");
	const { getServerPort } = await import("../remote-access-server");
	const cloudflaredInstalled = isCloudflaredAvailable();
	const tunnelState = getTunnelState();

	if (params?.tunnel && cloudflaredInstalled && tunnelState === "idle") {
		await startTunnel(getServerPort());
	}

	const qrDataUrl = await generateQrDataUrl();
	const accessUrl = await getAccessUrl();
	return { qrDataUrl, accessUrl, tunnelState: getTunnelState(), cloudflaredInstalled };
}

async function checkCloudflared(): Promise<{ installed: boolean }> {
	const { isCloudflaredAvailable } = await import("../cloudflare-tunnel");
	return { installed: isCloudflaredAvailable() };
}

async function startTunnel(): Promise<{ url: string | null; state: string }> {
	const { startTunnel: doStartTunnel, getTunnelState } = await import("../cloudflare-tunnel");
	const { getServerPort } = await import("../remote-access-server");
	const url = await doStartTunnel(getServerPort());
	return { url, state: getTunnelState() };
}

async function stopTunnel(): Promise<void> {
	const { stopTunnel: stop } = await import("../cloudflare-tunnel");
	stop();
}

export const remoteAccessHandlers = {
	getRemoteAccessQR,
	checkCloudflared,
	startTunnel,
	stopTunnel,
};
