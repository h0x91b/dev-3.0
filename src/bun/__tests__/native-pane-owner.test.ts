/**
 * Cross-instance owner routing for native panes (seq 1377).
 *
 * The host hands the writer lease to ONE client across every dev3 app process,
 * so a process holding a binding may still be an observer whose writes vanish.
 * What must hold: the owner is read from the host and never guessed, a live peer
 * owner is named precisely enough to forward to, and every case the host cannot
 * answer resolves to `unknown` — never to "vacant", which would invite a claim
 * that steals the lease from whoever is typing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn((_path: unknown) => true),
	readFileSync: vi.fn(() => ""),
	kill: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
}));

import { peerEndpointForPid, resolvePaneOwner } from "../native-pane-owner";
import type { NativeTaskTerminal } from "../native-task-terminal";

const OTHER_PID = 4711;

/** A binding whose host-side verdict the test controls. */
function terminal(opts: {
	hostRole: "writer" | "observer";
	writerPid?: number | null | undefined;
}): NativeTaskTerminal {
	return {
		sessionId: "dev3-task-abc-pane-1",
		paneId: "pane-1",
		hostPid: 10,
		shellPid: 11,
		write: vi.fn(),
		resize: vi.fn(),
		detach: vi.fn(),
		hostRole: () => opts.hostRole,
		claimHostWriter: vi.fn(async () => opts.hostRole),
		writerPid: vi.fn(async () => opts.writerPid),
	} as unknown as NativeTaskTerminal;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.existsSync.mockReturnValue(true);
	vi.spyOn(process, "kill").mockImplementation(mocks.kill as never);
	mocks.kill.mockReturnValue(true as never);
});

describe("resolvePaneOwner", () => {
	it("is local when the host already made this process the writer", async () => {
		const owner = await resolvePaneOwner(terminal({ hostRole: "writer" }));
		expect(owner).toEqual({ kind: "local" });
	});

	it("does not even ask the host who owns it when we are the writer", async () => {
		const term = terminal({ hostRole: "writer" });
		await resolvePaneOwner(term);
		expect(term.writerPid).not.toHaveBeenCalled();
	});

	it("names the peer process that holds the lease", async () => {
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: OTHER_PID }));
		expect(owner).toEqual({
			kind: "peer",
			pid: OTHER_PID,
			endpoint: expect.stringContaining(`${OTHER_PID}.sock`),
		});
	});

	it("is vacant only when the host explicitly says nobody holds it", async () => {
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: null }));
		expect(owner).toEqual({ kind: "vacant" });
	});

	// An older host reports no pid at all. Reading that as "vacant" would make a
	// caller claim the lease and cut off whoever is actually typing.
	it("is unknown — never vacant — when the host cannot report a writer pid", async () => {
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: undefined }));
		expect(owner).toEqual({ kind: "unknown" });
	});

	it("is unknown when the owning process is no longer alive", async () => {
		mocks.kill.mockImplementation(() => { throw new Error("ESRCH"); });
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: OTHER_PID }));
		expect(owner).toEqual({ kind: "unknown" });
	});

	it("is unknown when the owner is alive but has no reachable socket", async () => {
		mocks.existsSync.mockReturnValue(false);
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: OTHER_PID }));
		expect(owner).toEqual({ kind: "unknown" });
	});

	// Our client says observer while the host names us: a role change we have not
	// seen yet. Writing on that basis is how a message lands twice or not at all.
	it("is unknown when the host names us but our own client disagrees", async () => {
		const owner = await resolvePaneOwner(terminal({ hostRole: "observer", writerPid: process.pid }));
		expect(owner).toEqual({ kind: "unknown" });
	});

	it("is gone without a binding", async () => {
		expect(await resolvePaneOwner(null)).toEqual({ kind: "gone" });
	});
});

describe("peerEndpointForPid", () => {
	it("prefers the unix socket", () => {
		expect(peerEndpointForPid(OTHER_PID)).toContain(`${OTHER_PID}.sock`);
	});

	it("falls back to the loopback endpoint record", () => {
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith(".endpoint.json"));
		expect(peerEndpointForPid(OTHER_PID)).toContain(`${OTHER_PID}.endpoint.json`);
	});

	it("rejects a dead process instead of handing back a stale path", () => {
		mocks.kill.mockImplementation(() => { throw new Error("ESRCH"); });
		expect(peerEndpointForPid(OTHER_PID)).toBeNull();
	});

	it("rejects a nonsense pid", () => {
		expect(peerEndpointForPid(0)).toBeNull();
		expect(peerEndpointForPid(-1)).toBeNull();
	});
});
