/**
 * LAN pairing candidate ranking.
 *
 * A phone (or any other device) pairing with dev3 over the local network can
 * only reach the Mac at an address that routes across the shared Wi-Fi/Ethernet
 * segment. `os.networkInterfaces()` also reports VPN tunnels, VM/Internet-
 * Sharing bridges and Apple peer-to-peer links whose addresses are *not*
 * reachable from another device — and it often lists those first. Auto-picking
 * "the first non-internal IPv4" then embeds an unreachable host in the QR /
 * pairing URL, so the phone burns a full connect timeout per bad candidate.
 *
 * These pure helpers rank candidates so real LAN interfaces (en0…) float to the
 * top and non-routable ones sink below them. They take plain objects (no
 * `os` import) so they are trivially unit-testable.
 */

export interface NetIfaceLike {
	/** Interface name (e.g. "en0", "utun4", "bridge100", "loopback"). */
	name: string;
	/** The IPv4 address. */
	address: string;
	/** True for loopback / same-machine addresses. */
	internal?: boolean;
}

/**
 * Interface name prefixes that are (almost) never reachable from another device
 * on the LAN and so must never be the first pairing candidate:
 *  - utun / ipsec / ppp / tun / tap / wg  — VPN tunnels: point-to-point, the
 *    address routes only inside the tunnel; an external phone has no route to it
 *    and the VPN commonly blocks inbound LAN connections.
 *  - bridge / vmenet / vnic               — VM / container / Internet-Sharing
 *    host-only bridges: the subnet exists only between the Mac and its guests.
 *  - awdl / llw                           — Apple Wireless Direct Link / low-
 *    latency WLAN: link-local peer-to-peer transport, not a general LAN route.
 *  - ap                                   — personal-hotspot AP interface.
 */
const NON_ROUTABLE_PREFIXES = [
	"utun", "ipsec", "ppp", "tun", "tap", "wg",
	"bridge", "vmenet", "vnic",
	"awdl", "llw",
	"ap",
];

function isLinkLocal(address: string): boolean {
	return address.startsWith("169.254.");
}

function hasNonRoutableName(name: string): boolean {
	const lower = name.toLowerCase();
	return NON_ROUTABLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Reachability rank for a candidate IPv4 — higher is a better pairing host:
 *  3 — ordinary physical LAN (en* / eth*): Wi-Fi / Ethernet, routable across the
 *      local segment. The address a phone on the same Wi-Fi actually reaches.
 *  2 — other named interface not otherwise flagged: keep it, but below real LAN.
 *  1 — non-routable named interface (VPN tunnel, VM/host-only bridge, AWDL…) or
 *      a link-local 169.254.* address: usually unreachable from a phone.
 *  0 — loopback / internal (127.0.0.1): same-machine only, always last.
 */
export function rankInterface(iface: NetIfaceLike): number {
	if (iface.internal) return 0;
	if (hasNonRoutableName(iface.name) || isLinkLocal(iface.address)) return 1;
	const lower = iface.name.toLowerCase();
	if (lower.startsWith("en") || lower.startsWith("eth")) return 3;
	return 2;
}

/**
 * Stable-sort pairing candidates by descending reachability rank, preserving
 * the OS enumeration order within a rank. Real LAN (en0…) floats to the top,
 * VPN/bridge/link-local sink below it, loopback stays last. Non-mutating.
 */
export function prioritizeInterfaces<T extends NetIfaceLike>(list: T[]): T[] {
	return list
		.map((iface, index) => ({ iface, index, rank: rankInterface(iface) }))
		.sort((a, b) => (b.rank - a.rank) || (a.index - b.index))
		.map((entry) => entry.iface);
}
