/**
 * The desktop boot path must survive a taken remote-access port.
 *
 * `Bun.serve` throws SYNCHRONOUSLY on EADDRINUSE, and `src/bun/index.ts` calls
 * remote access with a top-level await — so an unguarded throw does not merely
 * kill remote access, it skips every statement below it (lifecycle rehydration
 * and all nine background schedulers) and Electrobun kills the worker outright.
 *
 * These cases pin the guard AND the promise the guard makes: a pinned port that
 * is taken stays a visible failure, never a silent move to some other port.
 *
 * Vitest runs on Node, where `Bun.serve` is a stub (`src/bun/test-setup.ts`), so
 * the throw here reproduces Bun's contract — the exact message, thrown
 * synchronously — rather than a real OS bind. The real bind against a real
 * occupied port is `remote-access-port-in-use.bun-e2e.ts`, run under Bun.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/nonexistent-views" },
	Utils: {},
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
	},
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	getLogPath: () => "/tmp",
}));

import {
	getRemoteAccessStatus,
	resetRemoteAccessStartState,
	setRemoteAccessStatusHook,
	startRemoteAccessServerGuarded,
} from "../remote-access-server";

const startOptions = {
	rpcHandler: async () => ({}),
	getPtyPort: () => 0,
	registerBackpressureProbe: () => () => {},
};

const TAKEN_PORT = 45999;
let originalPortEnv: string | undefined;
let originalServe: unknown;

beforeEach(() => {
	originalPortEnv = process.env.DEV3_REMOTE_PORT;
	originalServe = (globalThis as any).Bun.serve;
	delete process.env.DEV3_REMOTE_STATIC_CODE;
	resetRemoteAccessStartState();
});

afterEach(() => {
	(globalThis as any).Bun.serve = originalServe;
	if (originalPortEnv === undefined) delete process.env.DEV3_REMOTE_PORT;
	else process.env.DEV3_REMOTE_PORT = originalPortEnv;
	resetRemoteAccessStartState();
});

/**
 * Bun's own behaviour when the port is taken, verbatim: it throws from the
 * `Bun.serve` call itself, before any promise exists to reject.
 */
function serveThrowsPortInUse(): void {
	process.env.DEV3_REMOTE_PORT = String(TAKEN_PORT);
	(globalThis as any).Bun.serve = (opts: { port?: number }) => {
		const err = new Error(`Failed to start server. Is port ${opts.port} in use?`);
		(err as unknown as { code: string }).code = "EADDRINUSE";
		throw err;
	};
}

describe("remote access on a port that is already taken", () => {
	it("does not throw, so the statements after it on the boot path still run", async () => {
		serveThrowsPortInUse();

		// The canary: with an unguarded start this assignment is never reached,
		// which is exactly what happens to rehydrateTaskLifecycles in index.ts.
		let bootContinued = false;
		await startRemoteAccessServerGuarded(startOptions);
		bootContinued = true;

		expect(bootContinued).toBe(true);
	});

	it("reports the failure with the port that was refused", async () => {
		serveThrowsPortInUse();

		const status = await startRemoteAccessServerGuarded(startOptions);

		expect(status.running).toBe(false);
		expect(status.failure?.reason).toBe("port-in-use");
		expect(status.failure?.port).toBe(TAKEN_PORT);
		expect(getRemoteAccessStatus().failure?.port).toBe(TAKEN_PORT);
	});

	it("never silently moves a pinned port to a working one", async () => {
		serveThrowsPortInUse();

		const status = await startRemoteAccessServerGuarded(startOptions);

		// A pin exists to keep an external URL or a Docker mapping valid. Serving
		// on some other port would look like success and break the thing the pin
		// was for, so "down and saying so" is the required outcome.
		expect(status.port).toBe(0);
		expect(status.running).toBe(false);
	});

	it("tells the UI through the status hook", async () => {
		serveThrowsPortInUse();
		const seen: unknown[] = [];
		setRemoteAccessStatusHook((status) => seen.push(status));

		await startRemoteAccessServerGuarded(startOptions);

		expect(seen).toHaveLength(1);
		expect((seen[0] as { failure: unknown }).failure).not.toBeNull();
	});
});
