import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	clearRemoteState,
	clearRemoteStateIfOwnedBy,
	isProcessAlive,
	readRemoteState,
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
