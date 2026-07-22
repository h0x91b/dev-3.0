import { describe, expect, it } from "vitest";
import { classifyOwnership, type OwnershipProbes } from "../ownership";
import { NATIVE_SESSION_SCHEMA_VERSION, type NativeSessionRecord } from "../record";

// A well-formed 48-hex session token (the Windows Job Object name requires it).
const VALID_TOKEN = "a".repeat(48);

function record(evidenceKind: "posix-start-signature" | "windows-job"): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: "s",
		paneId: "s:0",
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: evidenceKind === "windows-job" ? "win32" : "linux",
		host: { pid: 100, executable: "bun", startSignature: "100@t0" },
		shell: { pid: 200, command: ["bash"], startSignature: "200@t0" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 1 },
		ownership: { evidenceKind },
		cols: 80,
		rows: 24,
		createdAt: "t",
		updatedAt: "t",
	};
}

function probes(overrides: Partial<OwnershipProbes>): OwnershipProbes {
	return {
		isAlive: () => true,
		readSignature: (pid) => `${pid}@t0`,
		isInJob: async () => true,
		...overrides,
	};
}

describe("classifyOwnership — POSIX start signatures", () => {
	const rec = record("posix-start-signature");

	it("owned when both PIDs are alive with matching start signatures", async () => {
		expect(await classifyOwnership(rec, "tok", probes({}))).toBe("owned");
	});

	it("dead when a recorded PID is gone", async () => {
		expect(await classifyOwnership(rec, "tok", probes({ isAlive: (pid) => pid !== 200 }))).toBe("dead");
	});

	it("reused when a PID is alive but its start signature changed", async () => {
		expect(await classifyOwnership(rec, "tok", probes({ readSignature: (pid) => `${pid}@LATER` }))).toBe("reused");
	});
});

describe("classifyOwnership — Windows Job membership", () => {
	const rec = record("windows-job");

	it("owned when host and shell are both job members", async () => {
		expect(await classifyOwnership(rec, VALID_TOKEN, probes({}))).toBe("owned");
	});

	it("reused when the live PID is not in the session job", async () => {
		expect(await classifyOwnership(rec, VALID_TOKEN, probes({ isInJob: async (_t, pid) => pid === 100 }))).toBe("reused");
	});

	it("reused when the private token is missing (cannot open the job)", async () => {
		expect(await classifyOwnership(rec, null, probes({}))).toBe("reused");
	});

	it("reused (never throws) when the token is malformed — one corrupt token cannot abort a sweep", async () => {
		let jobConsulted = false;
		const verdict = await classifyOwnership(
			rec,
			"not-a-valid-hex-token",
			probes({
				isInJob: async () => {
					jobConsulted = true;
					return true;
				},
			}),
		);
		expect(verdict).toBe("reused");
		expect(jobConsulted).toBe(false);
	});

	it("dead when a recorded PID is gone (never consults the job)", async () => {
		let jobConsulted = false;
		const verdict = await classifyOwnership(
			rec,
			VALID_TOKEN,
			probes({
				isAlive: () => false,
				isInJob: async () => {
					jobConsulted = true;
					return true;
				},
			}),
		);
		expect(verdict).toBe("dead");
		expect(jobConsulted).toBe(false);
	});
});
