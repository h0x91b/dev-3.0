import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeSessionClient } from "../client";
import { encodeControl, welcomeMessage } from "../protocol";
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

async function connect(client: NativeSessionClient, sessionId: string): Promise<FakeWebSocket> {
	const connecting = client.connect(record(sessionId), "token", { timeoutMs: 1000 });
	const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	if (!socket) throw new Error("fake socket was not created");
	socket.emit("open", new Event("open"));
	await Promise.resolve();
	const hello = JSON.parse(String(socket.sent[0])) as { id: number };
	socket.emitMessage(encodeControl(welcomeMessage(hello.id, sessionId)));
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

	it("ignores a delayed close event from an older socket after reconnect", async () => {
		const client = new NativeSessionClient();
		const first = await connect(client, "first");
		client.close();
		await connect(client, "second");

		first.emit("close", new Event("close"));

		expect(() => client.input("still-connected")).not.toThrow();
	});
});
