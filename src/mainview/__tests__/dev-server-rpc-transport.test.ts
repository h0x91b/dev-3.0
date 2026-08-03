/**
 * Dev Server ops over the remote (browser) RPC transport.
 *
 * Pins whether a request issued while the socket is down is DROPPED or QUEUED: it is
 * queued and flushed on reconnect, which makes "alive UI, no handler ran" a
 * remote-transport behaviour that the desktop transport cannot produce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SentPacket {
	type: string;
	id: number;
	method: string;
	params?: { taskId?: string; projectId?: string; opId?: string };
}

const TASK_ID = "af011a56-da9a-4197-856e-d3da040f3293";
const PROJECT_ID = "a1c9fe4e-8389-4214-9018-4a2580c261f0";
const CYCLES = 20;

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	readonly sent: string[] = [];
	readonly close = vi.fn();
	private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(public readonly url: string) {
		sockets.push(this);
	}

	send(packet: string) {
		this.sent.push(packet);
	}

	addEventListener(type: string, listener: (event: unknown) => void) {
		const current = this.listeners.get(type) ?? [];
		current.push(listener);
		this.listeners.set(type, current);
	}

	dispatch(type: string, event: unknown = {}) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	/** Every request packet this socket actually put on the wire. */
	packets(): SentPacket[] {
		return this.sent.map((raw) => JSON.parse(raw) as SentPacket);
	}

	/** Answer a request the way the backend would, so the caller's promise settles. */
	reply(id: number, payload: unknown) {
		this.dispatch("message", { data: JSON.stringify({ type: "response", id, success: true, payload }) });
	}
}

let sockets: MockWebSocket[] = [];

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sockets = [];
	delete (window as unknown as { __electrobunWebviewId?: string }).__electrobunWebviewId;
	document.documentElement.classList.remove("browser-mode");
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
	vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.documentElement.classList.remove("browser-mode");
});

async function bootConnected() {
	const mod = await import("../rpc");
	await Promise.resolve();
	await Promise.resolve();
	const socket = sockets[0]!;
	socket.readyState = MockWebSocket.OPEN;
	socket.dispatch("open");
	await Promise.resolve();
	return { api: mod.api, socket };
}

/** Only the Dev Server methods; the boot handshake issues its own traffic. */
function devServerPackets(socket: MockWebSocket): SentPacket[] {
	return socket
		.packets()
		.filter((p) => p.method === "runDevServer" || p.method === "stopDevServer");
}

describe("Dev Server ops over the remote transport", () => {
	it(`carries a distinct opId to the wire for all ${CYCLES} start/stop cycles`, async () => {
		const { api, socket } = await bootConnected();
		const request = api.request as unknown as Record<string, (p: unknown) => Promise<unknown>>;

		for (let cycle = 1; cycle <= CYCLES; cycle++) {
			for (const method of ["runDevServer", "stopDevServer"] as const) {
				const opId = `op${String(cycle).padStart(2, "0")}${method === "runDevServer" ? "a" : "b"}`;
				const settled = request[method]!({ taskId: TASK_ID, projectId: PROJECT_ID, opId });
				await Promise.resolve();
				const wire = devServerPackets(socket);
				const packet = wire[wire.length - 1]!;
				expect(packet.method).toBe(method);
				// The whole point of the id: the wire carries it, so the handler can
				// echo it and a request with only one side becomes visible.
				expect(packet.params?.opId).toBe(opId);
				socket.reply(packet.id, { running: method === "runDevServer" });
				await settled;
			}
		}

		const packets = devServerPackets(socket);
		expect(packets).toHaveLength(CYCLES * 2);
		// No op silently reused another's id, and none was dropped before the wire.
		expect(new Set(packets.map((p) => p.params?.opId)).size).toBe(CYCLES * 2);
	});

	it("queues a Dev Server op issued while the socket is down and flushes it on reconnect", async () => {
		vi.useFakeTimers();
		const mod = await import("../rpc");
		await Promise.resolve();
		await Promise.resolve();
		const first = sockets[0]!;
		first.readyState = MockWebSocket.OPEN;
		first.dispatch("open");
		first.readyState = MockWebSocket.CLOSED;
		first.dispatch("close", { code: 1006, reason: "network gone" });

		const request = mod.api.request as unknown as Record<string, (p: unknown) => Promise<unknown>>;
		// This is the exact situation the browser reproduction was in: the gesture
		// lands, the renderer flips its own state, and the socket is not OPEN.
		const settled = request.runDevServer!({ taskId: TASK_ID, projectId: PROJECT_ID, opId: "queued1" });
		await Promise.resolve();

		// Nothing reached the wire — which is why no handler line appeared in the log.
		expect(devServerPackets(first)).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(2_000);
		const replacement = sockets[1]!;
		expect(replacement).toBeDefined();
		replacement.readyState = MockWebSocket.OPEN;
		replacement.dispatch("open");
		await Promise.resolve();

		// It was HELD, not lost: the replacement socket sends it, id intact. So the
		// "alive UI, no handler" symptom is deferred delivery in this transport, not
		// data loss — and not something the desktop transport can even do.
		const flushed = devServerPackets(replacement);
		expect(flushed).toHaveLength(1);
		expect(flushed[0]!.params?.opId).toBe("queued1");

		replacement.reply(flushed[0]!.id, { running: true });
		await expect(settled).resolves.toEqual({ running: true });
	});
});
