import { getAccessUrl, generateQrDataUrl, getLocalInterfaces, getSignInLink, getStaticCode, resolveAccessHost } from "../remote-access-server";
import type { RemoteAccessStatus, RemoteNetInterface } from "../../shared/types";

/** Give Cloudflare's quick-tunnel hostname time to propagate before publishing it to the UI. */
export const TUNNEL_DNS_SETTLE_DELAY_MS = 5_000;

async function getRemoteAccessQR(params: { tunnel?: boolean; host?: string }): Promise<{ qrDataUrl: string; accessUrl: string; tunnelState: string; tunnelBinaryInstalled: boolean; tunnelProvider: "cloudflare" | "custom" | "misconfigured"; tunnelFailureReason: string | null; interfaces: RemoteNetInterface[]; selectedHost: string; staticCodeActive: boolean; signInLink: string | null; serverStatus: RemoteAccessStatus }> {
	const { isTunnelBinaryAvailable, getTunnelState, getMainTunnelFailureReason, startTunnel } = await import("../cloudflare-tunnel");
	const { resolveRemoteTunnelProvider } = await import("../tunnel-provider");
	const { getServerPort, getRemoteAccessStatus: readStatus } = await import("../remote-access-server");
	const serverStatus = readStatus();
	const tunnelBinaryInstalled = isTunnelBinaryAvailable();
	const tunnelProvider = resolveRemoteTunnelProvider().kind;
	const tunnelState = getTunnelState();

	// Nothing is listening, so there is nothing to tunnel to and no URL worth
	// minting: a QR built on port 0 is a link that looks real and cannot work.
	// The modal renders the failure instead and offers the way out.
	if (!serverStatus.running) {
		return {
			qrDataUrl: "", accessUrl: "", tunnelState, tunnelBinaryInstalled, tunnelProvider,
			tunnelFailureReason: getMainTunnelFailureReason(), interfaces: getLocalInterfaces(),
			selectedHost: resolveAccessHost(params?.host), staticCodeActive: getStaticCode() !== null,
			signInLink: null, serverStatus,
		};
	}

	// Opening Remote Access is an explicit request to share the app, so the
	// public tunnel is the default when cloudflared is available. Callers that
	// need a local/LAN URL pass tunnel: false (for example, the interface picker).
	if (params?.tunnel !== false && tunnelBinaryInstalled && tunnelState === "idle") {
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
		tunnelBinaryInstalled,
		tunnelProvider,
		tunnelFailureReason: getMainTunnelFailureReason(),
		interfaces: getLocalInterfaces(),
		selectedHost: resolveAccessHost(host),
		// Whether a code is set — never the code itself. The modal only says
		// "someone can also sign in by typing it" and warns about the tunnel.
		staticCodeActive: getStaticCode() !== null,
		// The one place the code reaches the renderer, and only inside a link the
		// user copies by an explicit click — it is never rendered on screen.
		signInLink: await getSignInLink(host),
		serverStatus,
	};
}

/**
 * Whether remote access is actually serving. The QR modal and Settings both read
 * it: with the server down `getServerPort()` is 0, so a QR minted anyway would
 * point at `http://host:0/` — a link that looks real and cannot work.
 */
async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
	const { getRemoteAccessStatus: read } = await import("../remote-access-server");
	return read();
}

async function retryRemoteAccess(): Promise<RemoteAccessStatus> {
	const { retryRemoteAccessServer } = await import("../remote-access-server");
	return retryRemoteAccessServer();
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
	getRemoteAccessStatus,
	retryRemoteAccess,
	startTunnel,
	stopTunnel,
};
