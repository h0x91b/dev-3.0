/**
 * Browser RPC WebSocket server.
 *
 * When the UI is opened in a regular browser (Chrome, Safari) instead of the
 * Electrobun shell, it needs a plain WebSocket transport for RPC. This module
 * provides that — a lightweight WS server that speaks the same JSON packet
 * protocol as Electrobun's internal IPC but without encryption.
 *
 * Wire protocol (same as electrobun/shared/rpc.ts):
 *   Request:  { type: "request",  id: number, method: string, params: any }
 *   Response: { type: "response", id: number, success: boolean, payload/error }
 *   Message:  { type: "message",  id: string, payload: any }
 */

import { createLogger } from "./logger";

const log = createLogger("browser-rpc");

export const BROWSER_RPC_PORT = 19191;

type RpcRequestHandler = (method: string, params: any) => Promise<any>;

/** All currently connected browser WebSocket clients. */
const clients = new Set<any>();

let requestHandler: RpcRequestHandler | null = null;
let ptyPortGetter: (() => number) | null = null;

/**
 * Start the browser RPC WebSocket server.
 * @param handler — function that routes RPC method calls to handlers
 * @param getPtyPort — callback to get the current PTY WebSocket port
 */
export function startBrowserRpcServer(handler: RpcRequestHandler, getPtyPort?: () => number): void {
	ptyPortGetter = getPtyPort ?? null;
	requestHandler = handler;

	const server = Bun.serve({
		port: BROWSER_RPC_PORT,
		fetch(req, server) {
			const url = new URL(req.url);

			// CORS preflight for fetch requests (not WS, but just in case)
			if (req.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: corsHeaders(),
				});
			}

			// WebSocket upgrade for /rpc
			if (url.pathname === "/rpc") {
				if (server.upgrade(req)) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Health check endpoint — also serves the PTY port for browser clients
			if (url.pathname === "/health") {
				return Response.json(
					{ ok: true, ptyPort: ptyPortGetter?.() ?? 0 },
					{ headers: corsHeaders() },
				);
			}

			return new Response("Browser RPC server", { status: 200, headers: corsHeaders() });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
				log.info("Browser RPC client connected", { total: clients.size });
			},
			async message(ws, raw) {
				try {
					const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer);
					const packet = JSON.parse(text);

					if (packet.type === "request") {
						if (!requestHandler) {
							ws.send(JSON.stringify({
								type: "response",
								id: packet.id,
								success: false,
								error: "RPC handler not ready",
							}));
							return;
						}
						try {
							const result = await requestHandler(packet.method, packet.params);
							ws.send(JSON.stringify({
								type: "response",
								id: packet.id,
								success: true,
								payload: result,
							}));
						} catch (err) {
							ws.send(JSON.stringify({
								type: "response",
								id: packet.id,
								success: false,
								error: err instanceof Error ? err.message : String(err),
							}));
						}
					}
					// Browser doesn't send messages (push) to bun, so we ignore other types
				} catch (err) {
					log.error("Browser RPC message parse error", { error: String(err) });
				}
			},
			close(ws) {
				clients.delete(ws);
				log.info("Browser RPC client disconnected", { total: clients.size });
			},
		},
	});

	log.info(`Browser RPC server running on ws://localhost:${server.port}/rpc`);
}

/**
 * Push a message to all connected browser clients.
 * Same format as Electrobun push messages.
 */
export function pushToBrowserClients(name: string, payload: any): void {
	if (clients.size === 0) return;
	const packet = JSON.stringify({ type: "message", id: name, payload });
	for (const ws of clients) {
		try {
			ws.send(packet);
		} catch {
			// Client may have disconnected — will be cleaned up on close
		}
	}
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}
