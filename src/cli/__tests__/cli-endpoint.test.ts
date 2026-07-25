import { describe, it, expect } from "vitest";
import {
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	isCliEndpointHandle,
	parseCliEndpointRecord,
	pidFromCliEndpointFileName,
	serializeCliEndpointRecord,
	type CliEndpointRecord,
} from "../../shared/cli-endpoint";

function record(overrides: Partial<CliEndpointRecord> = {}): CliEndpointRecord {
	return {
		v: CLI_ENDPOINT_VERSION,
		pid: 4242,
		host: CLI_LOOPBACK_HOST,
		port: 51515,
		token: "a".repeat(64),
		hostTaskId: null,
		startedAt: "2026-07-25T10:00:00.000Z",
		...overrides,
	};
}

describe("endpoint handle naming", () => {
	it("names records by pid and round-trips the pid back", () => {
		expect(cliEndpointFileName(4242)).toBe("4242.endpoint.json");
		expect(pidFromCliEndpointFileName("4242.endpoint.json")).toBe(4242);
	});

	it("recognizes only endpoint records as loopback handles", () => {
		expect(isCliEndpointHandle("/x/sockets/4242.endpoint.json")).toBe(true);
		expect(isCliEndpointHandle("/x/sockets/4242.sock")).toBe(false);
		expect(isCliEndpointHandle("/x/sockets/4242.meta.json")).toBe(false);
	});

	it("returns null for names that are not records", () => {
		expect(pidFromCliEndpointFileName("4242.sock")).toBeNull();
		expect(pidFromCliEndpointFileName("not-a-pid.endpoint.json")).toBeNull();
		expect(pidFromCliEndpointFileName("readme.txt")).toBeNull();
	});
});

describe("parseCliEndpointRecord", () => {
	it("round-trips a valid record", () => {
		expect(parseCliEndpointRecord(serializeCliEndpointRecord(record()))).toEqual(record());
	});

	it("keeps the launching task id when present", () => {
		const parsed = parseCliEndpointRecord(serializeCliEndpointRecord(record({ hostTaskId: "task-1" })));
		expect(parsed?.hostTaskId).toBe("task-1");
	});

	it("normalizes an empty task id to null (primary instance)", () => {
		const parsed = parseCliEndpointRecord(JSON.stringify({ ...record(), hostTaskId: "" }));
		expect(parsed?.hostTaskId).toBeNull();
	});

	it("rejects a non-loopback host so a tampered record cannot redirect the CLI", () => {
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "0.0.0.0" })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "192.168.1.10" })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "localhost" })))).toBeNull();
	});

	it("rejects an unknown record version", () => {
		expect(parseCliEndpointRecord(JSON.stringify({ ...record(), v: 2 }))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify({ ...record(), v: undefined }))).toBeNull();
	});

	it("rejects an out-of-range or missing port", () => {
		expect(parseCliEndpointRecord(JSON.stringify(record({ port: 0 })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ port: 70000 })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify({ ...record(), port: "51515" }))).toBeNull();
	});

	it("rejects a missing or empty token", () => {
		expect(parseCliEndpointRecord(JSON.stringify(record({ token: "" })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify({ ...record(), token: undefined }))).toBeNull();
	});

	it("rejects a bad pid", () => {
		expect(parseCliEndpointRecord(JSON.stringify(record({ pid: 0 })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ pid: -5 })))).toBeNull();
	});

	it("rejects garbage instead of throwing", () => {
		expect(parseCliEndpointRecord("")).toBeNull();
		expect(parseCliEndpointRecord("not json")).toBeNull();
		expect(parseCliEndpointRecord("null")).toBeNull();
		expect(parseCliEndpointRecord("[]")).toBeNull();
	});
});
