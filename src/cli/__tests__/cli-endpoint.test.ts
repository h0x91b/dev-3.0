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
	it("names records by pid, round-trips the pid, and recognizes only endpoint records", () => {
		expect(cliEndpointFileName(4242)).toBe("4242.endpoint.json");
		expect(pidFromCliEndpointFileName("4242.endpoint.json")).toBe(4242);
		expect(isCliEndpointHandle("/x/sockets/4242.endpoint.json")).toBe(true);
		for (const name of ["4242.sock", "4242.meta.json"]) expect(isCliEndpointHandle(`/x/sockets/${name}`), name).toBe(false);
		for (const name of ["4242.sock", "not-a-pid.endpoint.json", "readme.txt"]) expect(pidFromCliEndpointFileName(name), name).toBeNull();
	});
});

describe("parseCliEndpointRecord", () => {
	it("round-trips a valid record, keeps a launching task id and normalizes an empty one to null", () => {
		expect(parseCliEndpointRecord(serializeCliEndpointRecord(record()))).toEqual(record());
		expect(parseCliEndpointRecord(serializeCliEndpointRecord(record({ hostTaskId: "task-1" })))?.hostTaskId).toBe("task-1");
		expect(parseCliEndpointRecord(JSON.stringify({ ...record(), hostTaskId: "" }))?.hostTaskId).toBeNull();
	});

	it("rejects a non-loopback host so a tampered record cannot redirect the CLI", () => {
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "0.0.0.0" })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "192.168.1.10" })))).toBeNull();
		expect(parseCliEndpointRecord(JSON.stringify(record({ host: "localhost" })))).toBeNull();
	});

	it("rejects a bad version, port, token or pid, and garbage, instead of throwing", () => {
		const bad: Array<[string, string]> = [
			["v 2", JSON.stringify({ ...record(), v: 2 })],
			["no v", JSON.stringify({ ...record(), v: undefined })],
			["port 0", JSON.stringify(record({ port: 0 }))],
			["port 70000", JSON.stringify(record({ port: 70000 }))],
			["port string", JSON.stringify({ ...record(), port: "51515" })],
			["empty token", JSON.stringify(record({ token: "" }))],
			["no token", JSON.stringify({ ...record(), token: undefined })],
			["pid 0", JSON.stringify(record({ pid: 0 }))],
			["pid -5", JSON.stringify(record({ pid: -5 }))],
			["empty", ""],
			["not json", "not json"],
			["null", "null"],
			["array", "[]"],
		];
		for (const [label, raw] of bad) expect(parseCliEndpointRecord(raw), label).toBeNull();
	});
});
