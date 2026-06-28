import { getAccessUrl, generateQrDataUrl, getLocalInterfaces, resolveAccessHost } from "../remote-access-server";
import type { RemoteNetInterface } from "../../shared/types";

async function getRemoteAccessQR(params: { tunnel?: boolean; host?: string }): Promise<{ qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean; interfaces: RemoteNetInterface[]; selectedHost: string }> {
	const { isCloudflaredAvailable, getTunnelState, startTunnel } = await import("../cloudflare-tunnel");
	const { getServerPort } = await import("../remote-access-server");
	const cloudflaredInstalled = isCloudflaredAvailable();
	const tunnelState = getTunnelState();

	if (params?.tunnel && cloudflaredInstalled && tunnelState === "idle") {
		await startTunnel(getServerPort());
	}

	const host = params?.host;
	const qrDataUrl = await generateQrDataUrl(host);
	const accessUrl = await getAccessUrl(host);
	return {
		qrDataUrl,
		accessUrl,
		tunnelState: getTunnelState(),
		cloudflaredInstalled,
		interfaces: getLocalInterfaces(),
		selectedHost: resolveAccessHost(host),
	};
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
