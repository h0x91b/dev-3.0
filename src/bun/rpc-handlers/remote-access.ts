import { getAccessUrl, generateQrDataUrl, getLocalInterfaces, resolveAccessHost } from "../remote-access-server";
import type { RemoteNetInterface } from "../../shared/types";

/** Give Cloudflare's quick-tunnel hostname time to propagate before publishing it to the UI. */
export const TUNNEL_DNS_SETTLE_DELAY_MS = 5_000;

async function getRemoteAccessQR(params: { tunnel?: boolean; host?: string }): Promise<{ qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean; interfaces: RemoteNetInterface[]; selectedHost: string }> {
	const { isCloudflaredAvailable, getTunnelState, startTunnel } = await import("../cloudflare-tunnel");
	const { getServerPort } = await import("../remote-access-server");
	const cloudflaredInstalled = isCloudflaredAvailable();
	const tunnelState = getTunnelState();

	// Opening Remote Access is an explicit request to share the app, so the
	// public tunnel is the default when cloudflared is available. Callers that
	// need a local/LAN URL pass tunnel: false (for example, the interface picker).
	if (params?.tunnel !== false && cloudflaredInstalled && tunnelState === "idle") {
		const tunnelUrl = await startTunnel(getServerPort());
		if (tunnelUrl) {
			// cloudflared prints the hostname before Cloudflare's edge has finished
			// provisioning DNS. Do not let the QR/link escape during that window.
			await new Promise<void>((resolve) => setTimeout(resolve, TUNNEL_DNS_SETTLE_DELAY_MS));
		}
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
