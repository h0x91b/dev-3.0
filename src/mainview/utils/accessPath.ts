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
	kind: "tunnel" | "lan" | "local" | "other";
	labelKey: TranslationKey;
	/** The hostname itself, for display. Identity-bearing — mask it. */
	host: string;
}

/**
 * `location.hostname` keeps the brackets on an IPv6 literal — a browser on
 * `http://[::1]:3000/` reports `[::1]`, never `::1` — so both spellings are
 * listed. Without the bracketed one an IPv6 loopback session was labelled as a
 * Cloudflare tunnel.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function describeAccessPath(hostname: string): AccessPath {
	const host = hostname || "unknown";
	if (LOCAL_HOSTS.has(host)) return { kind: "local", labelKey: "connQuality.pathLocal", host };
	// Quick tunnels and named tunnels both terminate on a Cloudflare edge; the
	// suffix is what tells them apart from a bare LAN address.
	if (/(^|\.)trycloudflare\.com$/i.test(host) || /(^|\.)cfargotunnel\.com$/i.test(host)) {
		return { kind: "tunnel", labelKey: "connQuality.pathTunnel", host };
	}
	// A bare IPv4 or a `.local` name is the interface picker's direct URL.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /\.local$/i.test(host)) {
		return { kind: "lan", labelKey: "connQuality.pathLan", host };
	}
	// Anything else — a custom domain, a bare LAN name, a Tailscale host — is
	// genuinely unknown to us, and naming Cloudflare here would put a specific
	// accusation on a route Cloudflare may never have carried.
	return { kind: "other", labelKey: "connQuality.pathOther", host };
}
