import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeSessionClient } from "../client";
import {
	encodeControl,
	HOST_CAPABILITIES,
	ownershipReply,
	resizedReply,
	welcomeMessage,
} from "../protocol";
import { NATIVE_SESSION_SCHEMA_VERSION, type NativeSessionRecord } from "../record";

interface FakeListener {
	listener: EventListenerOrEventListenerObject;
	once: boolean;
}

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	binaryType = "blob";
	readonly sent: unknown[] = [];
	private readonly listeners = new Map<string, FakeListener[]>();

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void {
		const once = typeof options === "object" && options.once === true;
		const listeners = this.listeners.get(type) ?? [];
		listeners.push({ listener, once });
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener),
		);
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	close(): void {}

	emit(type: string, event: Event): void {
		for (const entry of [...(this.listeners.get(type) ?? [])]) {
			if (typeof entry.listener === "function") entry.listener(event);
			else entry.listener.handleEvent(event);
			if (entry.once) this.removeEventListener(type, entry.listener);
		}
	}

	emitMessage(data: string): void {
		this.emit("message", { data } as MessageEvent);
	}
}

function record(sessionId: string): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: sessionId,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "win32",
		host: { pid: 10, executable: "bun.exe", startSignature: "host" },
		shell: { pid: 11, command: ["pwsh.exe"], startSignature: "shell" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 4321 },
		ownership: { evidenceKind: "windows-job" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-22T00:00:00.000Z",
		updatedAt: "2026-07-22T00:00:00.000Z",
	};
}

/** The frames this fake has sent, parsed. */
function sentFrames(socket: FakeWebSocket): Array<Record<string, unknown>> {
	return socket.sent.map((raw) => JSON.parse(String(raw)) as Record<string, unknown>);
}

function lastSent(socket: FakeWebSocket, type: string): Record<string, unknown> | undefined {
	return sentFrames(socket).filter((f) => f.type === type).pop();
}

/**
 * Connect and answer the attach-time status read, so tests are deterministic instead of
 * waiting out its timeout. `capabilities` lets a test model an older host.
 */
async function connect(
	client: NativeSessionClient,
	sessionId: string,
	opts: { capabilities?: readonly string[]; role?: "writer" | "observer"; generation?: number } = {},
): Promise<FakeWebSocket> {
	const connecting = client.connect(record(sessionId), "token", { timeoutMs: 1000 });
	const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	if (!socket) throw new Error("fake socket was not created");
	socket.emit("open", new Event("open"));
	await Promise.resolve();
	const hello = JSON.parse(String(socket.sent[0])) as { id: number };
	socket.emitMessage(encodeControl(welcomeMessage(hello.id, sessionId, opts.role ?? "writer", {
		capabilities: (opts.capabilities ?? HOST_CAPABILITIES) as never,
		writerGeneration: opts.generation ?? 1,
	})));
	// The client reads status right after hello; answer it at its own correlated id.
	await Promise.resolve();
	const statusFrame = lastSent(socket, "status");
	if (statusFrame) {
		socket.emitMessage(encodeControl({
			v: 1,
			id: statusFrame.id as number,
			type: "status",
			sessionId,
			paneId: sessionId,
			hostPid: 10,
			shellPid: 11,
			cols: 80,
			rows: 24,
			alive: true,
			startedAt: "2026-07-22T00:00:00.000Z",
			clientRole: opts.role ?? "writer",
			writerAttached: true,
			writerGeneration: opts.generation ?? 1,
		}));
	}
	await connecting;
	return socket;
}

describe("NativeSessionClient socket ownership", () => {
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
	});

	it("becomes logically disconnected as soon as close is called", async () => {
		const client = new NativeSessionClient();
		await connect(client, "first");

		client.close();

		expect(() => client.input("after-close")).toThrow("not connected");
	});

	// ── correlated control requests ───────────
	// Separate id counters per type used to collide, so a resize conflict carrying id N
	// could settle an unrelated takeover holding id N. Correlation is now (id, kind,
	// connection) out of ONE allocator.
	it("never reuses an id across request kinds, so a resize error cannot settle a takeover", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "collide");

		const takeover = client.takeoverWriter({ timeoutMs: 1000 });
		const resize = client.resizeAwaited(120, 40, { timeoutMs: 1000 });
		await Promise.resolve();
		const ownershipId = lastSent(socket, "ownership")?.id as number;
		const resizeId = lastSent(socket, "resize")?.id as number;
		expect(resizeId).not.toBe(ownershipId);

		// The resize is refused. The takeover must be untouched and still settle on its own.
		socket.emitMessage(encodeControl({ v: 1, type: "error", code: "conflict", id: resizeId, message: "writer generation is stale" }));
		await expect(resize).rejects.toThrow(/conflict/);
		socket.emitMessage(encodeControl(ownershipReply(ownershipId, "writer", true, 2)));
		await expect(takeover).resolves.toMatchObject({ role: "writer" });
		expect(client.getRole()).toBe("writer");
	});

	it("resolves a resize only from its OWN acknowledgement, and caches only then", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "ack");
		const before = client.getPtyGeometry();

		const resize = client.resizeAwaited(120, 40, { timeoutMs: 1000 });
		await Promise.resolve();
		const id = lastSent(socket, "resize")?.id as number;

		// A wrong-id ack must neither settle the request nor touch the cache.
		socket.emitMessage(encodeControl(resizedReply(id + 99, 999, 999, 5)));
		expect(client.getPtyGeometry()).toEqual(before);

		socket.emitMessage(encodeControl(resizedReply(id, 120, 40, 2)));
		await expect(resize).resolves.toMatchObject({ cols: 120, rows: 40 });
		expect(client.getPtyGeometry()).toEqual({ cols: 120, rows: 40 });
		expect(client.getWriterGeneration()).toBe(2);

		// A duplicate of the same ack has nothing to settle and must not re-apply.
		socket.emitMessage(encodeControl(resizedReply(id, 777, 777, 9)));
		expect(client.getPtyGeometry()).toEqual({ cols: 120, rows: 40 });
		expect(client.getWriterGeneration()).toBe(2);
	});

	it("sends the generation it believes in, so the host can refuse a stale resize", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "gen", { generation: 4 });

		void client.resizeAwaited(90, 30, { timeoutMs: 1000 }).catch(() => undefined);
		await Promise.resolve();

		expect(lastSent(socket, "resize")).toMatchObject({ cols: 90, rows: 30, expectedGeneration: 4 });
	});

	it("does not cache a LATE acknowledgement that arrives after its timeout", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "late-ack");
		const before = client.getPtyGeometry();

		const resize = client.resizeAwaited(150, 50, { timeoutMs: 5 });
		const id = lastSent(socket, "resize")?.id as number;
		await expect(resize).rejects.toThrow(/resize timeout/);

		socket.emitMessage(encodeControl(resizedReply(id, 150, 50, 8)));
		expect(client.getPtyGeometry()).toEqual(before);
		expect(client.getWriterGeneration()).not.toBe(8);
	});

	// The sharpest one: a timed-out takeover the host commits anyway. The late reply must
	// do NOTHING, or ownership flips after the click that asked for it is long gone.
	it("ignores a LATE nonzero ownership reply — a timeout is not a second chance", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "late-ownership", { role: "observer" });

		const takeover = client.takeoverWriter({ timeoutMs: 5 });
		const id = lastSent(socket, "ownership")?.id as number;
		await expect(takeover).rejects.toThrow(/timeout/);

		socket.emitMessage(encodeControl(ownershipReply(id, "writer", true, 3)));

		expect(client.getRole()).toBe("observer");
		expect(client.getLateOwnershipReplyCount()).toBe(1);
	});

	it("still applies an id=0 frame, which is the ONLY unsolicited kind", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "unsolicited", { role: "observer" });
		const roles: string[] = [];
		client.onRoleChange((role) => roles.push(role));

		socket.emitMessage(encodeControl(ownershipReply(0, "writer", true, 6)));

		expect(client.getRole()).toBe("writer");
		expect(client.getWriterGeneration()).toBe(6);
		expect(roles).toEqual(["writer"]);
	});

	it("treats an id=0 status as a canonical-geometry broadcast, not a reply", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "geometry");
		const sizes: Array<{ cols: number; rows: number }> = [];
		client.onGeometry((size) => sizes.push(size));

		socket.emitMessage(encodeControl({
			v: 1, type: "status", id: 0, sessionId: "geometry", paneId: "geometry",
			hostPid: 10, shellPid: 11, cols: 132, rows: 43, alive: true,
			startedAt: "2026-07-22T00:00:00.000Z", writerAttached: true, writerGeneration: 7,
		}));

		expect(sizes).toEqual([{ cols: 132, rows: 43 }]);
		expect(client.getPtyGeometry()).toEqual({ cols: 132, rows: 43 });
	});

	it("cannot be settled by a reply belonging to a socket we have already replaced", async () => {
		const client = new NativeSessionClient();
		const first = await connect(client, "sock-a", { role: "observer" });
		const takeover = client.takeoverWriter({ timeoutMs: 1000 });
		const id = lastSent(first, "ownership")?.id as number;
		client.close(); // the pending request dies with its socket
		await expect(takeover.catch((e) => e)).resolves.toBeInstanceOf(Error);

		await connect(client, "sock-b", { role: "observer" });
		first.emitMessage(encodeControl(ownershipReply(id, "writer", true, 4)));

		expect(client.getRole()).toBe("observer");
	});

	it("reports a host that does not announce resize-ack instead of faking a confirmation", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "old-host", { capabilities: [] });

		await expect(client.resizeAwaited(100, 30)).rejects.toThrow(/does not support resize-ack/);
		// It still sends the resize, uncorrelated, exactly as an older client would.
		expect(lastSent(socket, "resize")).toMatchObject({ cols: 100, rows: 30 });
		expect(lastSent(socket, "resize")?.id).toBeUndefined();
	});

	// Internal settlement must happen BEFORE any external listener runs, and each
	// listener is isolated. Otherwise a throwing (or reconnecting) listener strands the
	// request, which becomes a timeout and then an unnecessary compensation.
	it("settles the exact request before external listeners, so a throwing one cannot strand it", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "throwing", { role: "observer" });
		const seen: string[] = [];
		client.onError(() => { throw new Error("listener exploded"); });
		client.onError((e) => seen.push(e.code));

		const takeover = client.takeoverWriter({ timeoutMs: 2000 });
		await Promise.resolve();
		const id = lastSent(socket, "ownership")?.id as number;
		socket.emitMessage(encodeControl({ v: 1, type: "error", code: "conflict", id, message: "another client is already the writer" }));

		// Settled with the host's real verdict, not a timeout.
		const err = await takeover.catch((e) => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error & { code?: string }).code).toBe("conflict");
		// The surviving listener still ran, so isolation works in both directions.
		expect(seen).toEqual(["conflict"]);
	});

	it("keeps settling requests when a role listener throws", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "throwing-role", { role: "observer" });
		client.onRoleChange(() => { throw new Error("role listener exploded"); });

		socket.emitMessage(encodeControl(ownershipReply(0, "writer", true, 3)));
		expect(client.getRole()).toBe("writer");

		// A subsequent correlated request still settles normally.
		const status = client.status({ timeoutMs: 1000 });
		await Promise.resolve();
		const id = lastSent(socket, "status")?.id as number;
		socket.emitMessage(encodeControl({
			v: 1, type: "status", id, sessionId: "throwing-role", paneId: "p",
			hostPid: 10, shellPid: 11, cols: 80, rows: 24, alive: true,
			startedAt: "2026-07-22T00:00:00.000Z", writerAttached: true, writerGeneration: 3,
		}));
		await expect(status).resolves.toMatchObject({ cols: 80 });
	});

	it("reports a refusal as a TYPED error so callers stop matching message text", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "typed", { role: "observer" });

		const takeover = client.takeoverWriter({ timeoutMs: 1000 });
		await Promise.resolve();
		const id = lastSent(socket, "ownership")?.id as number;
		socket.emitMessage(encodeControl({ v: 1, type: "error", code: "unauthorized", id }));

		const err = (await takeover.catch((e) => e)) as Error & { code?: string };
		expect(err.name).toBe("HostRefusedError");
		expect(err.code).toBe("unauthorized");
	});

	// A rebind must drop the host's replay but keep bytes produced while the handshake was
	// still finishing. Both land in the same pre-listener buffer, so only the host's
	// explicit boundary can tell them apart.
	it("drops replayed frames on a rebind and KEEPS live output that followed the boundary", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "replay-boundary");
		const encoder = new TextEncoder();

		// History, boundary, then a marker emitted before any listener attached.
		socket.emit("message", { data: encoder.encode("OLD-HISTORY").buffer } as MessageEvent);
		socket.emitMessage(encodeControl({ v: 1, type: "replayed" }));
		socket.emit("message", { data: encoder.encode("LIVE-MARKER").buffer } as MessageEvent);

		expect(client.discardReplayedOutput()).toBe(1);

		const seen: string[] = [];
		client.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)));
		expect(seen.join("")).toBe("LIVE-MARKER");
	});

	// The byte cap evicts from the FRONT, which is where the replay sits. A count of
	// leading replay frames goes stale the moment that happens, and discarding by that
	// count then deletes live output. Frames are tagged instead, so identity survives.
	it("survives cap eviction: discard removes only remaining replay and keeps the marker", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "replay-evict");
		const encoder = new TextEncoder();
		const big = new Uint8Array(200 * 1024);

		// A replay large enough that the next frames push it past the 256 KiB cap.
		socket.emit("message", { data: big.buffer } as MessageEvent);
		socket.emit("message", { data: big.buffer } as MessageEvent);
		socket.emitMessage(encodeControl({ v: 1, type: "replayed" }));
		// Live output, then more live bytes that force eviction of the leading replay.
		socket.emit("message", { data: encoder.encode("LIVE-MARKER").buffer } as MessageEvent);
		socket.emit("message", { data: big.buffer } as MessageEvent);

		client.discardReplayedOutput();

		const seen: string[] = [];
		client.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)));
		const joined = seen.join("");
		expect(joined).toContain("LIVE-MARKER");
		// Exactly once, and no replay left behind.
		expect(joined.split("LIVE-MARKER").length - 1).toBe(1);
	});

	it("keeps everything when the host announces no replay boundary", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "old-replay", { capabilities: ["takeover"] });
		const encoder = new TextEncoder();
		socket.emit("message", { data: encoder.encode("HISTORY-AND-LIVE").buffer } as MessageEvent);

		// null = "cannot tell them apart", so the caller must not drop anything: duplicated
		// history is recoverable, a lost marker is not.
		expect(client.discardReplayedOutput()).toBeNull();
		const seen: string[] = [];
		client.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)));
		expect(seen.join("")).toBe("HISTORY-AND-LIVE");
	});

	it("ignores a delayed close event from an older socket after reconnect", async () => {
		const client = new NativeSessionClient();
		const first = await connect(client, "first");
		client.close();
		await connect(client, "second");

		first.emit("close", new Event("close"));

		expect(() => client.input("still-connected")).not.toThrow();
	});
});

describe("NativeSessionClient disconnect evidence", () => {
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
	});

	it("reports a socket that closed between connect returning and the subscription", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "late-subscribe");
		socket.emit("close", new Event("close"));

		// Subscribing after the fact must still learn: the evidence is sticky, not a
		// one-shot callback list that has already been drained.
		let sawCallback = false;
		client.onDisconnect(() => {
			sawCallback = true;
		});
		expect(sawCallback).toBe(true);
		await expect(client.whenDisconnected()).resolves.toBeUndefined();
	});

	it("resolves whenDisconnected immediately for an already-closed connection", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "already-closed");
		socket.emit("close", new Event("close"));

		let resolved = false;
		void client.whenDisconnected().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(true);
	});

	it("runs every disconnect callback even when one throws", async () => {
		const client = new NativeSessionClient();
		const socket = await connect(client, "throwing-callback");
		const ran: string[] = [];
		client.onDisconnect(() => {
			ran.push("first");
			throw new Error("subscriber exploded");
		});
		client.onDisconnect(() => ran.push("second"));
		client.onDisconnect(() => ran.push("third"));

		expect(() => socket.emit("close", new Event("close"))).not.toThrow();
		expect(ran).toEqual(["first", "second", "third"]);
	});

	it("clears the sticky flag on a reconnect", async () => {
		const client = new NativeSessionClient();
		const first = await connect(client, "reconnects");
		first.emit("close", new Event("close"));
		await expect(client.whenDisconnected()).resolves.toBeUndefined();

		await connect(client, "reconnects");
		let resolved = false;
		void client.whenDisconnected().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
	});
});
