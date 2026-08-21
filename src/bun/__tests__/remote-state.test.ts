import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { RemoteServerState } from "../../shared/types";

// Redirect DEV3_HOME to an isolated tmp dir so the real fs round-trips never
// touch the developer's actual ~/.dev3.0. `vi.hoisted` keeps the path available
// to the (hoisted) vi.mock factory without a TDZ crash; process.pid keeps it
// unique + stable across this run.
const TEST_HOME = vi.hoisted(() => {
	const base = (process.env.TMPDIR || process.env.TMP || "/tmp").replace(/\/$/, "");
	return `${base}/dev3-remote-state-test-${process.pid}`;
});
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));

import {
	REMOTE_DIR,
	REMOTE_STATE_FILE,
	REMOTE_START_LOCK_FILE,
	acquireStartLock,
	clearRemoteState,
	clearRemoteStateIfOwnedBy,
	isProcessAlive,
	carriedOverState,
	readRemoteState,
	recordUpdateFailure,
	releaseStartLock,
	writeRemoteState,
} from "../remote-state";

function sampleState(overrides: Partial<RemoteServerState> = {}): RemoteServerState {
	return {
		pid: process.pid,
		port: 41234,
		socketPath: "/tmp/dev3-test.sock",
		tunnelRequested: true,
		staticCode: null,
		logFile: `${REMOTE_DIR}/remote.log`,
		startedAt: "2026-06-28T10:00:00.000Z",
		version: "1.27.0",
		...overrides,
	};
}

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("remote-state path derivation", () => {
	it("nests under the (mocked) DEV3_HOME/remote", () => {
		expect(REMOTE_DIR).toBe(`${TEST_HOME}/remote`);
		expect(REMOTE_STATE_FILE).toBe(`${TEST_HOME}/remote/state.json`);
	});
});

describe("writeRemoteState / readRemoteState", () => {
	it("round-trips a full state record", () => {
		const state = sampleState();
		writeRemoteState(state);
		expect(existsSync(REMOTE_STATE_FILE)).toBe(true);
		expect(readRemoteState()).toEqual(state);
	});

	it("creates the remote dir if it does not exist", () => {
		rmSync(REMOTE_DIR, { recursive: true, force: true });
		writeRemoteState(sampleState());
		expect(existsSync(REMOTE_STATE_FILE)).toBe(true);
	});

	it("returns null when no state file exists", () => {
		expect(readRemoteState()).toBeNull();
	});

	it("returns null for corrupt JSON", () => {
		mkdirSync(REMOTE_DIR, { recursive: true });
		writeFileSync(REMOTE_STATE_FILE, "{ not json");
		expect(readRemoteState()).toBeNull();
	});

	it("returns null when required fields are missing", () => {
		mkdirSync(REMOTE_DIR, { recursive: true });
		writeFileSync(REMOTE_STATE_FILE, JSON.stringify({ pid: 123 }));
		expect(readRemoteState()).toBeNull();
	});

	it("coerces optional fields to safe defaults", () => {
		mkdirSync(REMOTE_DIR, { recursive: true });
		writeFileSync(
			REMOTE_STATE_FILE,
			JSON.stringify({ pid: 5, port: 80, socketPath: "/s.sock" }),
		);
		expect(readRemoteState()).toEqual({
			pid: 5,
			port: 80,
			socketPath: "/s.sock",
			tunnelRequested: false,
			staticCode: null,
			logFile: null,
			startedAt: "",
			version: "",
		});
	});
});

describe("clearRemoteState", () => {
	it("removes an existing state file", () => {
		writeRemoteState(sampleState());
		clearRemoteState();
		expect(existsSync(REMOTE_STATE_FILE)).toBe(false);
	});

	it("is a no-op when no file exists", () => {
		expect(() => clearRemoteState()).not.toThrow();
	});
});

describe("clearRemoteStateIfOwnedBy", () => {
	it("clears when the pid matches", () => {
		writeRemoteState(sampleState({ pid: 777 }));
		clearRemoteStateIfOwnedBy(777);
		expect(readRemoteState()).toBeNull();
	});

	it("leaves a record owned by a different pid intact", () => {
		writeRemoteState(sampleState({ pid: 777 }));
		clearRemoteStateIfOwnedBy(888);
		expect(readRemoteState()).not.toBeNull();
	});
});

describe("acquireStartLock / releaseStartLock (F4)", () => {
	it("grants the lock to the first caller and refuses a concurrent second", () => {
		const fd = acquireStartLock();
		expect(typeof fd).toBe("number");
		expect(existsSync(REMOTE_START_LOCK_FILE)).toBe(true);
		// Second concurrent launch must be refused while the first holds it.
		expect(acquireStartLock()).toBeNull();
		releaseStartLock(fd as number);
	});

	it("releases the lock so a later launch can re-acquire it", () => {
		const fd1 = acquireStartLock();
		releaseStartLock(fd1 as number);
		expect(existsSync(REMOTE_START_LOCK_FILE)).toBe(false);
		const fd2 = acquireStartLock();
		expect(typeof fd2).toBe("number");
		releaseStartLock(fd2 as number);
	});

	it("reclaims a stale lock left by a crashed launcher", () => {
		mkdirSync(REMOTE_DIR, { recursive: true });
		// Simulate an abandoned lock: create it, then backdate its mtime past the
		// staleness window so the next launch reclaims it instead of giving up.
		writeFileSync(REMOTE_START_LOCK_FILE, "");
		const past = new Date(Date.now() - 60_000);
		utimesSync(REMOTE_START_LOCK_FILE, past, past);
		const fd = acquireStartLock();
		expect(typeof fd).toBe("number");
		releaseStartLock(fd as number);
	});

	it("does NOT reclaim a fresh lock held by a live launcher", () => {
		const fd = acquireStartLock();
		// A brand-new lock (mtime ~ now) must be respected, not reclaimed.
		expect(acquireStartLock()).toBeNull();
		releaseStartLock(fd as number);
	});
});

describe("isProcessAlive", () => {
	it("is true for the current process", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("is false for an unused high pid", () => {
		expect(isProcessAlive(2_000_000_000)).toBe(false);
	});

	it("is false for non-positive / non-integer pids", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(1.5)).toBe(false);
	});
});

describe("handoff records", () => {
	// A dead pid that is not going to be recycled inside a test run. `fromPid` MUST
	// look dead for a handoff to be ours to take, and `tunnel.pid` MUST look alive
	// for the inherited process to be worth adopting — so these tests use
	// process.pid for "alive" and this for "dead".
	const DEAD_PID = 2_000_000_000;

	it("round-trips a handoff whose writer has exited and whose tunnel is alive", () => {
		writeRemoteState(sampleState({
			handoff: { port: 41234, fromPid: DEAD_PID, tunnel: { pid: process.pid, url: "https://x.trycloudflare.com", metricsReadyUrl: "http://127.0.0.1:20241/ready" } },
			lastUpdate: { fromVersion: "1.45.0", toVersion: "1.45.2", startedAt: "2026-08-20T01:00:00.000Z" },
		}));
		const read = readRemoteState();
		expect(read?.handoff).toEqual({
			port: 41234,
			fromPid: DEAD_PID,
			tunnel: { pid: process.pid, url: "https://x.trycloudflare.com", metricsReadyUrl: "http://127.0.0.1:20241/ready" },
		});
		expect(read?.lastUpdate?.toVersion).toBe("1.45.2");
	});

	it("discards a handoff whose writer is still running — it is not ours to take", () => {
		writeRemoteState(sampleState({
			handoff: { port: 41234, fromPid: process.pid, tunnel: null },
		}));
		expect(readRemoteState()?.handoff).toBeUndefined();
	});

	it("drops a DEAD tunnel but keeps the port — adopting it would publish an NXDOMAIN link", () => {
		writeRemoteState(sampleState({
			handoff: { port: 41234, fromPid: DEAD_PID, tunnel: { pid: DEAD_PID, url: "https://x.trycloudflare.com", metricsReadyUrl: null } },
		}));
		const handoff = readRemoteState()?.handoff;
		expect(handoff?.port).toBe(41234);
		expect(handoff?.tunnel).toBeNull();
	});

	it("rejects a handoff with an out-of-range port instead of trying to bind it", () => {
		writeRemoteState(sampleState({
			handoff: { port: 999_999, fromPid: DEAD_PID, tunnel: null },
		}));
		expect(readRemoteState()?.handoff).toBeUndefined();
	});

	it("leaves the keys absent for a record written before handoffs existed", () => {
		writeRemoteState(sampleState());
		expect(readRemoteState()?.handoff).toBeUndefined();
		expect(readRemoteState()?.lastUpdate).toBeUndefined();
	});

	it("ignores a malformed handoff block rather than throwing", () => {
		mkdirSync(REMOTE_DIR, { recursive: true });
		writeFileSync(REMOTE_STATE_FILE, JSON.stringify({
			...sampleState(),
			handoff: "not an object",
			lastUpdate: { fromVersion: 7 },
		}));
		const read = readRemoteState();
		expect(read?.handoff).toBeUndefined();
		expect(read?.lastUpdate).toBeUndefined();
	});
});

// The failure that matters most — an update that applies and then does not boot —
// destroys the process holding the in-memory attempt counter. The supervisor runs
// in a DIFFERENT process, so the count only survives if it is on disk.
describe("recordUpdateFailure", () => {
	it("counts up across calls for the same version", () => {
		writeRemoteState(sampleState());
		recordUpdateFailure("1.46.0", "did not boot", 1000);
		recordUpdateFailure("1.46.0", "did not boot again", 2000);

		expect(readRemoteState()?.updateAttempts).toEqual({
			version: "1.46.0",
			failures: 2,
			lastFailureMs: 2000,
			lastError: "did not boot again",
		});
	});

	it("resets the count when a NEW version starts failing", () => {
		writeRemoteState(sampleState());
		recordUpdateFailure("1.46.0", "boom", 1000);
		recordUpdateFailure("1.47.0", "boom", 2000);

		expect(readRemoteState()?.updateAttempts?.failures).toBe(1);
		expect(readRemoteState()?.updateAttempts?.version).toBe("1.47.0");
	});

	it("keeps every other field of the record intact", () => {
		writeRemoteState(sampleState({ port: 5555 }));
		recordUpdateFailure("1.46.0", "boom", 1000);

		const after = readRemoteState();
		expect(after?.port).toBe(5555);
		expect(after?.pid).toBe(process.pid);
	});

	it("does nothing when there is no server record to annotate", () => {
		clearRemoteState();
		expect(() => recordUpdateFailure("1.46.0", "boom", 1000)).not.toThrow();
		expect(readRemoteState()).toBeNull();
	});

	it("stays absent on an ordinary record, so nothing drifts for older readers", () => {
		writeRemoteState(sampleState());
		expect(readRemoteState()?.updateAttempts).toBeUndefined();
	});

	it("rejects a malformed attempts block instead of trusting it", () => {
		writeRemoteState(sampleState());
		const raw = JSON.parse(require("node:fs").readFileSync(REMOTE_STATE_FILE, "utf-8"));
		raw.updateAttempts = { version: "", failures: -3 };
		writeFileSync(REMOTE_STATE_FILE, JSON.stringify(raw));

		expect(readRemoteState()?.updateAttempts).toBeUndefined();
	});
});

describe("carriedOverState", () => {
	// The failure this exists for happens in ANOTHER process: the new build applies,
	// does not boot, the supervisor rolls back, and the restored server writes its
	// own state file BEFORE the failure is recorded. Dropping the counter on that
	// write pinned it at 1 forever — the give-up after five attempts was unreachable
	// and the box re-downloaded the same non-booting release every quiet window.
	it("carries the update record AND the attempt counter across a restart", () => {
		const prior: RemoteServerState = {
			...sampleState(),
			lastUpdate: { fromVersion: "1.45.0", toVersion: "1.46.0", startedAt: "2026-08-21T12:00:00Z" },
			updateAttempts: { version: "1.46.0", failures: 3, lastFailureMs: 1000, lastError: "did not boot" },
		};
		writeRemoteState(prior);

		const carried = carriedOverState(readRemoteState());

		expect(carried.lastUpdate?.toVersion).toBe("1.46.0");
		expect(carried.updateAttempts?.failures).toBe(3);
	});

	it("carries nulls when there was no predecessor at all", () => {
		expect(carriedOverState(null)).toEqual({ lastUpdate: null, updateAttempts: null });
	});

	// Written back through a full round-trip, because the point is that the NEXT
	// process reads it — and `recordUpdateFailure` then increments rather than resets.
	it("survives being written into the successor's own record", () => {
		writeRemoteState({
			...sampleState(),
			updateAttempts: { version: "1.46.0", failures: 4, lastFailureMs: 1000 },
		});
		const carried = carriedOverState(readRemoteState());

		writeRemoteState({ ...sampleState(), pid: process.pid, ...carried });
		recordUpdateFailure("1.46.0", "did not boot again", 2000);

		expect(readRemoteState()?.updateAttempts?.failures).toBe(5);
	});
});
