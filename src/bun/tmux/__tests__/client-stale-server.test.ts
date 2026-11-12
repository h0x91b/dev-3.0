import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const binary = vi.hoisted(() => ({ mismatch: null as { clientVersion: string; serverVersion: string } | null }));
vi.mock("../binary", async (importOriginal) => ({
	...(await importOriginal<typeof import("../binary")>()),
	getTmuxBinary: () => "/Applications/dev3.app/Contents/Resources/app/tmux/tmux",
	getTmuxServerVersionMismatch: () => binary.mismatch,
}));

const staleServerBinary = vi.hoisted(() => vi.fn());
vi.mock("../launchd-server", async (importOriginal) => ({
	...(await importOriginal<typeof import("../launchd-server")>()),
	staleServerBinary,
}));

import { TmuxClient } from "../client";

describe("TmuxClient.serverBinaryStale", () => {
	const client = new TmuxClient({ cwdExists: () => true, spawn: vi.fn() as never });

	beforeEach(() => {
		binary.mismatch = null;
		staleServerBinary.mockReset();
	});

	it("reports a server no known tmux can drive, before looking at its executable", () => {
		binary.mismatch = { clientVersion: "3.7", serverVersion: "3.6a" };
		expect(client.serverBinaryStale()).toBe("incompatible");
		expect(staleServerBinary).not.toHaveBeenCalled();
	});

	it("otherwise passes through the executable verdict", () => {
		staleServerBinary.mockReturnValue("deleted");
		expect(client.serverBinaryStale()).toBe("deleted");
		staleServerBinary.mockReturnValue(null);
		expect(client.serverBinaryStale()).toBeNull();
	});
});
