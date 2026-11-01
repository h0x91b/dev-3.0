/**
 * Sending one packet to a browser RPC socket without losing it silently.
 *
 * Bun's `ServerWebSocket.send` returns 0 and DROPS the message once the socket's
 * outgoing buffer is over `backpressureLimit` (16 MB by default) — every later
 * send too, a tiny response included, until the client catches up. The browser
 * keeps waiting for an answer that was thrown away. Measured on Bun 1.3: three
 * 6 MB sends queue (-1), every following send returns 0 and never arrives.
 *
 * A dropped packet therefore closes the socket: the client rejects every request
 * still in flight, reconnects, and refetches — loud recovery instead of a hang.
 * See decisions/2026/11/01/hold-startup-rpc-until-bridge-socket-opens.md.
 */

/** Close code the browser sees when a packet could not be queued. */
export const RPC_SOCKET_DROPPED_CLOSE_CODE = 4008;

export interface RpcSocketLike {
	/** 1 = OPEN, as on Bun's ServerWebSocket. A socket already closing just drops quietly. */
	readyState?: number;
	send(data: string): number;
	close(code?: number, reason?: string): void;
}

/** Returns false when the packet was dropped and the socket was closed. */
export function sendRpcPacket(
	ws: RpcSocketLike,
	packet: string,
	onDropped?: (bytes: number) => void,
): boolean {
	let status: number;
	try {
		status = ws.send(packet);
	} catch {
		return false;
	}
	if (status !== 0) return true;
	if (ws.readyState !== undefined && ws.readyState !== 1) return false;
	onDropped?.(packet.length);
	try {
		ws.close(RPC_SOCKET_DROPPED_CLOSE_CODE, "RPC packet dropped under backpressure");
	} catch {
		/* already closing */
	}
	return false;
}
