import type { TranslationKey } from "../i18n";

/**
 * Which route this page arrived over, from its own hostname alone.
 *
 * The distinction is load-bearing for the connection-quality readout: the same
 * round-trip number means "acceptable" over a Cloudflare tunnel and "something
 * is wrong" on the local network, and a reading only becomes a verdict against
 * the tunnel once the direct-LAN URL is measured for comparison.
 *
 * Hostname-only on purpose. The renderer cannot see how `cloudflared` was
 * started, and asking the backend would answer for the host rather than for this
 * page — a phone on the tunnel and a laptop on the LAN can be connected at the
 * same moment.
 */
export interface AccessPath {
	kind: "tunnel" | "lan" | "local";
	labelKey: TranslationKey;
	/** The hostname itself, for display. Identity-bearing — mask it. */
	host: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function describeAccessPath(hostname: string): AccessPath {
	const host = hostname || "unknown";
	if (LOCAL_HOSTS.has(host)) return { kind: "local", labelKey: "connQuality.pathLocal", host };
	// Quick tunnels and named tunnels both terminate on a Cloudflare edge; the
	// suffix is what tells them apart from a bare LAN address.
	if (/(^|\.)trycloudflare\.com$/i.test(host) || /(^|\.)cfargotunnel\.com$/i.test(host)) {
		return { kind: "tunnel", labelKey: "connQuality.pathTunnel", host };
	}
	// A bare IPv4 or a `.local` name is the interface picker's direct URL. Anything
	// else is a custom domain, which we cannot tell from a tunnel — call it what we
	// can defend: not local.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /\.local$/i.test(host)) {
		return { kind: "lan", labelKey: "connQuality.pathLan", host };
	}
	return { kind: "tunnel", labelKey: "connQuality.pathTunnel", host };
}
