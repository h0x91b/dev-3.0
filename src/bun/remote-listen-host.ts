/**
 * Where the remote-access server listens, from DEV3_REMOTE_HOST (set by
 * `dev3 remote --host`). Kept apart from remote-access-server.ts so the
 * headless banner can ask without importing the server.
 */

import { createLogger } from "./logger";
import { listenHostError } from "../shared/remote-listen-host";

const log = createLogger("remote-listen-host");

/**
 * Resolve the listen address from DEV3_REMOTE_HOST. Unset means `0.0.0.0`, the
 * historical bind: every interface, so LAN clients and the QR work.
 *
 * Set it to `127.0.0.1` (or `localhost`) to keep the server off the network
 * entirely - same-machine browsers, an SSH `-L` forward and the tunnel (which
 * dials `localhost`) still reach it. Only IPv4 literals are accepted: the
 * tunnel and the access URLs are built around IPv4, and an unparseable value
 * falls back to `0.0.0.0` with a warning, like an invalid port does.
 */
export function resolveListenHost(): string {
	const raw = process.env.DEV3_REMOTE_HOST?.trim();
	if (!raw) return "0.0.0.0";
	if (listenHostError(raw) === null) return raw === "localhost" ? "127.0.0.1" : raw;
	log.warn("Invalid remote access host, falling back to 0.0.0.0", { raw });
	return "0.0.0.0";
}

/** True when the server only accepts connections from this machine. */
export function isLoopbackListen(host: string = resolveListenHost()): boolean {
	return host.startsWith("127.");
}
