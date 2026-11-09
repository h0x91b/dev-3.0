/**
 * Who may reach the PTY server: this machine only, and only with the token
 * minted for this launch. See decisions/2026/11/08/pty-server-loopback-and-token.md.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { PTY_TOKEN_PARAM } from "../shared/pty-url";

/** A literal, not `localhost`: no client may depend on how its resolver orders `::1`. */
export const PTY_SERVER_HOST = "127.0.0.1";

// In memory only, new every launch: nothing on disk can unlock a terminal.
const accessToken = randomBytes(32).toString("base64url");

export function isLoopbackAddress(address: string | undefined): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** True when a terminal upgrade request carries this launch's access token. */
export function hasPtyAccessToken(url: URL): boolean {
	const given = Buffer.from(url.searchParams.get(PTY_TOKEN_PARAM) ?? "");
	const expected = Buffer.from(accessToken);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A terminal session's WebSocket URL, token included: for this machine's own UI and proxy only. */
export function ptyWsUrl(port: number, sessionKey: string): string {
	return `ws://${PTY_SERVER_HOST}:${port}?session=${encodeURIComponent(sessionKey)}&${PTY_TOKEN_PARAM}=${accessToken}`;
}

/** URL of one of the PTY server's plain HTTP routes, which carry their own credentials. */
export function ptyHttpUrl(port: number, path: string): string {
	return `http://${PTY_SERVER_HOST}:${port}${path}`;
}
