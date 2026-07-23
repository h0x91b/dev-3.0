import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseHostSessionRecord,
	readHostSessionRecord,
	readHostSessionToken,
	writeHostSessionRecord,
	writeHostSessionToken,
	type HostSessionRecord,
} from "../session-record";

const sample: HostSessionRecord = {
	schema: 1,
	sessionId: "old",
	paneId: "old:0",
	imageTag: "host-v1",
	protocolVersion: 1,
	entrypoint: "/images/host-v1/entrypoint.mjs",
	hostPid: 4242,
	shellPid: 4243,
	endpoint: { address: "127.0.0.1", port: 51234 },
	stateMarker: "mark",
	startedAt: "2026-07-23T00:00:00.000Z",
};

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "dev3-host-session-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe("host session record", () => {
	it("round-trips a record and token through disk", () => {
		writeHostSessionToken(stateDir, "secret-token");
		writeHostSessionRecord(stateDir, sample);
		expect(readHostSessionRecord(stateDir)).toEqual(sample);
		expect(readHostSessionToken(stateDir)).toBe("secret-token");
	});

	it("rejects corrupt, foreign-schema, and token-smuggling records", () => {
		expect(parseHostSessionRecord("{not json")).toBeNull();
		expect(parseHostSessionRecord(JSON.stringify({ ...sample, schema: 2 }))).toBeNull();
		expect(parseHostSessionRecord(JSON.stringify({ ...sample, token: "leak" }))).toBeNull();
		expect(parseHostSessionRecord(JSON.stringify({ ...sample, hostPid: "nope" }))).toBeNull();
	});

	it("returns null when no record or token exists yet", () => {
		expect(readHostSessionRecord(stateDir)).toBeNull();
		expect(readHostSessionToken(stateDir)).toBeNull();
	});
});
