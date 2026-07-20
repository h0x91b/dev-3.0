import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearState,
	isProcessAlive,
	logFile,
	readState,
	stateDir,
	stateFile,
	writeState,
	type PtyProtoState,
} from "../state";

const sample: PtyProtoState = {
	hostPid: 4242,
	shellPid: 4243,
	host: "127.0.0.1",
	port: 51234,
	token: "deadbeef",
	startedAt: "2026-07-20T00:00:00.000Z",
	cols: 100,
	rows: 30,
};

describe("detached-pty state", () => {
	let dir: string;
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env.DEV3_PTY_PROTO_DIR;
		dir = mkdtempSync(join(tmpdir(), "dev3-pty-state-"));
		process.env.DEV3_PTY_PROTO_DIR = dir;
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.DEV3_PTY_PROTO_DIR;
		else process.env.DEV3_PTY_PROTO_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("honours DEV3_PTY_PROTO_DIR for all paths", () => {
		expect(stateDir()).toBe(dir);
		expect(stateFile()).toBe(join(dir, "state.json"));
		expect(logFile()).toBe(join(dir, "host.log"));
	});

	it("round-trips a state record", () => {
		writeState(sample);
		expect(readState()).toEqual(sample);
	});

	it("returns null when no record exists", () => {
		expect(readState()).toBeNull();
	});

	it("returns null for corrupt JSON", () => {
		writeFileSync(stateFile(), "{ not json");
		expect(readState()).toBeNull();
	});

	it("returns null when required fields are missing or wrong-typed", () => {
		writeFileSync(stateFile(), JSON.stringify({ hostPid: "x", shellPid: 1, port: 1, host: "h", token: "t" }));
		expect(readState()).toBeNull();
		writeFileSync(stateFile(), JSON.stringify({ hostPid: 1, shellPid: 1, port: 1, host: "h" }));
		expect(readState()).toBeNull();
	});

	it("clearState removes the file, log, and empty dir", () => {
		writeState(sample);
		writeFileSync(logFile(), "log line");
		expect(existsSync(stateFile())).toBe(true);
		clearState();
		expect(existsSync(stateFile())).toBe(false);
		expect(existsSync(logFile())).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(readState()).toBeNull();
	});

	it("clearState is safe when nothing exists", () => {
		expect(() => clearState()).not.toThrow();
	});

	it("clearState only removes metadata owned by the selected session", () => {
		writeState(sample);
		writeFileSync(logFile(), "selected session log");

		expect(clearState("another-token")).toBe(false);
		expect(readState()).toEqual(sample);
		expect(existsSync(logFile())).toBe(true);

		expect(clearState(sample.token)).toBe(true);
		expect(readState()).toBeNull();
		expect(existsSync(logFile())).toBe(false);
	});

	it("isProcessAlive: true for self, false for junk", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(2.5)).toBe(false);
		// A very high PID is almost certainly unused.
		expect(isProcessAlive(2_000_000_000)).toBe(false);
	});
});
