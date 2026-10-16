/**
 * An external PTY session (the account sign-in terminal) rides the same WebSocket
 * handlers remote mode proxies, without ever touching tmux or the native host.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { encodeResizeSequence } from "../../shared/resize-protocol";
import { spawn } from "../spawn";

interface WsHandlers {
	open(ws: unknown): void;
	message(ws: unknown, message: string | Uint8Array): void;
	close(ws: unknown): void;
}
let handlers: WsHandlers;
const bun = globalThis as unknown as { Bun: { serve: (config: unknown) => unknown } };
const stubServe = bun.Bun.serve;
bun.Bun.serve = (config: unknown) => {
	const websocket = (config as { websocket?: WsHandlers }).websocket;
	if (websocket) handlers = websocket;
	return stubServe(config);
};

const pty = await import("../pty-server");

function client(key: string) {
	return { data: { url: new URL(`ws://localhost/?session=${key}`) }, sendText: vi.fn(), close: vi.fn() };
}

describe("external PTY sessions", () => {
	it("routes open, keystrokes, resize and close to the registered session only", () => {
		const session = { attach: vi.fn(), input: vi.fn(), resize: vi.fn(), detach: vi.fn() };
		const unregister = pty.registerExternalPtySession("account-login-x", session);
		const ws = client("account-login-x");

		handlers.open(ws);
		handlers.message(ws, "\r");
		handlers.message(ws, encodeResizeSequence(120, 40));
		handlers.close(ws);

		expect(session.attach).toHaveBeenCalledWith(ws);
		expect(session.input).toHaveBeenCalledWith(ws, "\r");
		expect(session.resize).toHaveBeenCalledWith(ws, 120, 40);
		expect(session.detach).toHaveBeenCalledWith(ws);
		expect(ws.close).not.toHaveBeenCalled();
		expect(pty.hasSession("account-login-x")).toBe(false);
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
		unregister();
	});

	it("an unregistered sign-in key is refused like any unknown session", () => {
		const session = { attach: vi.fn(), input: vi.fn(), resize: vi.fn(), detach: vi.fn() };
		pty.registerExternalPtySession("account-login-y", session)();
		const ws = client("account-login-y");
		handlers.open(ws);
		expect(session.attach).not.toHaveBeenCalled();
		expect(ws.close).toHaveBeenCalled();
	});
});
