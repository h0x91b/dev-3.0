import { describe, expect, it } from "vitest";
import {
	classifyOwnership,
	classifyOwnershipBatch,
	type BatchOwnershipProbes,
	type OwnershipProbes,
} from "../ownership";
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

	// The real probe shells out to `ps` and is async so a whole pane set can be
	// classified in one round trip instead of N (seq 1382).
	it("accepts an async signature probe", async () => {
		expect(
			await classifyOwnership(rec, "tok", probes({ readSignature: async (pid) => `${pid}@t0` })),
		).toBe("owned");
	});

	it("starts the host and shell probes together rather than in sequence", async () => {
		const started: number[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const verdict = classifyOwnership(rec, "tok", probes({
			readSignature: async (pid) => {
				started.push(pid);
				// The FIRST probe blocks. If the second only started after it resolved,
				// releasing the gate below would deadlock the assertion.
				if (started.length === 1) await gate;
				return `${pid}@t0`;
			},
		}));
		await Promise.resolve();
		expect(started).toEqual([100, 200]);
		releaseFirst();
		expect(await verdict).toBe("owned");
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

// ── One `ps` for a whole pane set (seq 1388) ──────────────────────────────────

describe("classifyOwnershipBatch — one probe, per-pid evidence", () => {
	/** A pane record with its own pid pair, so evidence can never be confused. */
	function pane(index: number, evidenceKind: "posix-start-signature" | "windows-job" = "posix-start-signature") {
		const base = record(evidenceKind);
		return {
			...base,
			sessionId: `pane-${index}`,
			host: { ...base.host, pid: 100 * index, startSignature: `${100 * index}@t0` },
			shell: { ...base.shell, pid: 100 * index + 1, startSignature: `${100 * index + 1}@t0` },
		};
	}

	function batchProbes(overrides: Partial<BatchOwnershipProbes> = {}): BatchOwnershipProbes {
		return {
			isAlive: () => true,
			readSignatures: async (pids) => new Map(pids.map((pid) => [pid, `${pid}@t0`])),
			isInJob: async () => true,
			...overrides,
		};
	}

	it("asks once for a six-pane set and answers in input order", async () => {
		const calls: number[][] = [];
		const entries = [1, 2, 3, 4, 5, 6].map((i) => ({ record: pane(i), token: "tok" }));

		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({
				readSignatures: async (pids) => {
					calls.push([...pids]);
					return new Map(pids.map((pid) => [pid, `${pid}@t0`]));
				},
			}),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(12); // host + shell for each of six panes
		expect(verdicts).toEqual(Array(6).fill("owned"));
	});

	it("gives the same verdict as the single-record classifier, per pane", async () => {
		const entries = [1, 2, 3].map((i) => ({ record: pane(i), token: "tok" }));
		const single = await Promise.all(
			entries.map(({ record: rec, token }) => classifyOwnership(rec, token, probes({}))),
		);
		expect(await classifyOwnershipBatch(entries, batchProbes())).toEqual(single);
	});

	it("marks only the pane whose pid is missing from the answer", async () => {
		const entries = [1, 2, 3].map((i) => ({ record: pane(i), token: "tok" }));
		const verdicts = await classifyOwnershipBatch(
			entries,
			// Pane 2's shell never came back — nothing else may inherit that.
			batchProbes({
				readSignatures: async (pids) =>
					new Map(pids.filter((pid) => pid !== 201).map((pid) => [pid, `${pid}@t0`])),
			}),
		);
		expect(verdicts).toEqual(["owned", "reused", "owned"]);
	});

	it("marks only the pane whose pid was reused", async () => {
		const entries = [1, 2].map((i) => ({ record: pane(i), token: "tok" }));
		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({
				readSignatures: async (pids) =>
					new Map(pids.map((pid) => [pid, pid === 100 ? `${pid}@LATER` : `${pid}@t0`])),
			}),
		);
		expect(verdicts).toEqual(["reused", "owned"]);
	});

	it("reports a dead pane without asking for a signature for it", async () => {
		const entries = [1, 2].map((i) => ({ record: pane(i), token: "tok" }));
		const asked: number[] = [];
		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({
				isAlive: (pid) => pid !== 200,
				readSignatures: async (pids) => {
					asked.push(...pids);
					return new Map(pids.map((pid) => [pid, `${pid}@t0`]));
				},
			}),
		);
		expect(verdicts).toEqual(["owned", "dead"]);
		expect(asked).toEqual([100, 101]);
	});

	it("treats an unavailable or failed ps as unverifiable, never as owned", async () => {
		const entries = [1, 2].map((i) => ({ record: pane(i), token: "tok" }));
		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({ readSignatures: async () => new Map() }),
		);
		expect(verdicts).toEqual(["reused", "reused"]);
	});

	it("verifies a record whose host and shell share one pid without duplicating evidence", async () => {
		const base = pane(1);
		const shared = { ...base, shell: { ...base.shell, pid: base.host.pid, startSignature: base.host.startSignature } };
		let requested: readonly number[] = [];
		const verdicts = await classifyOwnershipBatch(
			[{ record: shared, token: "tok" }],
			batchProbes({
				readSignatures: async (pids) => {
					requested = pids;
					return new Map(pids.map((pid) => [pid, `${pid}@t0`]));
				},
			}),
		);
		expect(verdicts).toEqual(["owned"]);
		expect(requested).toEqual([100, 100]);
	});

	it("never runs the POSIX probe for Windows records", async () => {
		let posixProbed = false;
		const entries = [1, 2].map((i) => ({ record: pane(i, "windows-job"), token: VALID_TOKEN }));

		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({
				readSignatures: async () => {
					posixProbed = true;
					return new Map();
				},
			}),
		);

		expect(posixProbed).toBe(false);
		expect(verdicts).toEqual(["owned", "owned"]);
	});

	it("keeps Windows job verdicts per record while POSIX siblings batch", async () => {
		const entries = [
			{ record: pane(1), token: "tok" },
			{ record: pane(2, "windows-job"), token: VALID_TOKEN },
			{ record: pane(3, "windows-job"), token: null },
		];
		const verdicts = await classifyOwnershipBatch(
			entries,
			batchProbes({ isInJob: async (_token, pid) => pid !== 201 }),
		);
		expect(verdicts).toEqual(["owned", "reused", "reused"]);
	});

	it("does not probe at all for an empty pane set", async () => {
		let probed = false;
		const verdicts = await classifyOwnershipBatch(
			[],
			batchProbes({
				readSignatures: async () => {
					probed = true;
					return new Map();
				},
			}),
		);
		expect(verdicts).toEqual([]);
		expect(probed).toBe(false);
	});
});
