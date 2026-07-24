import { describe, expect, it } from "vitest";
import {
	buildDiagnosticsSnapshot,
	DIAGNOSTICS_STALE_AFTER_MS,
	NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA,
	NATIVE_TERMINAL_DIAGNOSTICS_VERSION,
	type DiagnosticsLiveInput,
	type DiagnosticsRecordInput,
	type NativeTerminalDiagnosticsInput,
} from "../snapshot";

const NOW = "2026-07-24T12:00:00.000Z";

/**
 * A caller's real record type is richer than the diagnostics input; this mirrors
 * the registry record so the redaction test can prove the extra secret-bearing
 * fields never reach the snapshot.
 */
interface RecordWithSecrets extends DiagnosticsRecordInput {
	host?: { pid?: number; executable?: string; startSignature?: string };
	shell?: { pid?: number; command?: string[]; startSignature?: string };
	endpoint?: { transport: string; address: string; port: number };
	ownership?: { evidenceKind: string };
	cols?: number;
	rows?: number;
}

/** A record laced with everything the snapshot must NEVER surface. */
function record(overrides: RecordWithSecrets = {}): RecordWithSecrets {
	return {
		sessionId: "alpha",
		paneId: "alpha:0",
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 4242, executable: "/secret/home/user/bun", startSignature: "4242@SIGNATURE-SECRET" },
		shell: { pid: 4243, command: ["/bin/bash", "-lc", "export API_KEY=SECRET_COMMAND"], startSignature: "4243@SIGNATURE-SECRET" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-24T11:00:00.000Z",
		updatedAt: "2026-07-24T11:59:59.000Z",
		...overrides,
	};
}

function live(overrides: DiagnosticsLiveInput = {}): DiagnosticsLiveInput {
	return {
		sessionId: "alpha",
		paneId: "alpha:0",
		hostPid: 4242,
		shellPid: 4243,
		alive: true,
		startedAt: "2026-07-24T11:00:05.000Z",
		clientRole: "writer",
		writerAttached: true,
		...overrides,
	};
}

function healthyInput(overrides: Partial<NativeTerminalDiagnosticsInput> = {}): NativeTerminalDiagnosticsInput {
	return {
		now: NOW,
		record: record(),
		live: live(),
		verdict: "owned",
		lastAttachAt: "2026-07-24T11:59:58.000Z",
		queue: { pendingBytes: 128, pendingEvents: 3, lastSeq: 42, droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 },
		snapshot: {
			updatedAt: "2026-07-24T11:59:59.500Z",
			watermarkSeq: 42,
			health: "live",
			frames: 100,
			bytes: 4096,
			resizes: 2,
			replies: 5,
		},
		...overrides,
	};
}

describe("buildDiagnosticsSnapshot", () => {
	it("is versioned and JSON-safe", () => {
		const snap = buildDiagnosticsSnapshot(healthyInput());
		expect(snap.schema).toBe(NATIVE_TERMINAL_DIAGNOSTICS_SCHEMA);
		expect(snap.version).toBe(NATIVE_TERMINAL_DIAGNOSTICS_VERSION);
		expect(snap.capturedAt).toBe(NOW);
		// Round-trips through JSON without loss (no NaN/Infinity/undefined).
		expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
	});

	it("healthy: reports every fact as known", () => {
		const snap = buildDiagnosticsSnapshot(healthyInput());
		expect(snap.lifecycle).toEqual({ known: true, value: "running" });
		expect(snap.identity.sessionId).toEqual({ known: true, value: "alpha" });
		expect(snap.identity.viewId).toEqual({ known: true, value: "alpha:0" });
		expect(snap.identity.protocolVersion).toEqual({ known: true, value: 1 });
		expect(snap.identity.runtimeVersion).toEqual({ known: true, value: "1.3.14" });
		expect(snap.process.hostPid).toEqual({ known: true, value: 4242 });
		expect(snap.process.shellPid).toEqual({ known: true, value: 4243 });
		expect(snap.writer.present).toEqual({ known: true, value: true });
		expect(snap.writer.role).toEqual({ known: true, value: "writer" });
		expect(snap.timing.lastAttachAt).toEqual({ known: true, value: "2026-07-24T11:59:58.000Z" });
		expect(snap.freshness).toEqual({ known: true, value: { ageMs: 500, stale: false } });
		expect(snap.counters.queue.known).toBe(true);
		expect(snap.counters.parserSnapshot).toMatchObject({ known: true, value: { ageMs: 500, health: "live", frames: 100 } });
	});

	it("stale: freshness flips once the parser heartbeat exceeds the threshold", () => {
		const stale = buildDiagnosticsSnapshot(
			healthyInput({ snapshot: { ...healthyInput().snapshot!, updatedAt: "2026-07-24T11:59:00.000Z" } }),
		);
		expect(stale.freshness).toEqual({ known: true, value: { ageMs: 60_000, stale: true } });
		expect(60_000).toBeGreaterThan(DIAGNOSTICS_STALE_AFTER_MS);

		const tunedThreshold = buildDiagnosticsSnapshot(healthyInput({ staleAfterMs: 100 }));
		expect(tunedThreshold.freshness).toEqual({ known: true, value: { ageMs: 500, stale: true } });
	});

	it("partial: record-only input marks live-only facts unknown", () => {
		const snap = buildDiagnosticsSnapshot({ now: NOW, record: record(), verdict: "owned" });
		// Identity/process/timing still resolve from the record.
		expect(snap.identity.sessionId).toEqual({ known: true, value: "alpha" });
		expect(snap.process.hostPid).toEqual({ known: true, value: 4242 });
		expect(snap.lifecycle).toEqual({ known: true, value: "running" });
		// Writer, shell start, attach, and counters are unavailable without live/parser data.
		expect(snap.writer.present.known).toBe(false);
		expect(snap.writer.role.known).toBe(false);
		expect(snap.timing.shellStartedAt.known).toBe(false);
		expect(snap.timing.lastAttachAt.known).toBe(false);
		expect(snap.freshness.known).toBe(false);
		expect(snap.counters.queue.known).toBe(false);
		expect(snap.counters.parserSnapshot.known).toBe(false);
	});

	it("missing: an empty capture reports every fact unknown with a reason", () => {
		const snap = buildDiagnosticsSnapshot({ now: NOW });
		const facts = [
			snap.lifecycle,
			snap.freshness,
			snap.identity.sessionId,
			snap.identity.viewId,
			snap.identity.protocolVersion,
			snap.identity.runtimeVersion,
			snap.identity.hostArtifactVersion,
			snap.identity.platform,
			snap.process.hostPid,
			snap.process.shellPid,
			snap.writer.present,
			snap.writer.role,
			snap.timing.createdAt,
			snap.timing.updatedAt,
			snap.timing.shellStartedAt,
			snap.timing.lastAttachAt,
			snap.counters.queue,
			snap.counters.parserSnapshot,
		];
		for (const fact of facts) {
			expect(fact.known).toBe(false);
			if (!fact.known) expect(fact.reason.length).toBeGreaterThan(0);
		}
	});

	it("lifecycle: derived from verdict, then live.alive as a fallback", () => {
		expect(buildDiagnosticsSnapshot({ now: NOW, verdict: "dead" }).lifecycle).toEqual({ known: true, value: "dead" });
		expect(buildDiagnosticsSnapshot({ now: NOW, verdict: "reused" }).lifecycle).toEqual({ known: true, value: "reused" });
		expect(buildDiagnosticsSnapshot({ now: NOW, verdict: "owned", live: live({ alive: false }) }).lifecycle).toEqual({
			known: true,
			value: "exited",
		});
		expect(buildDiagnosticsSnapshot({ now: NOW, live: live({ alive: false }) }).lifecycle).toEqual({ known: true, value: "exited" });
		expect(buildDiagnosticsSnapshot({ now: NOW, live: live() }).lifecycle).toEqual({ known: true, value: "running" });
	});

	it("boundedness: non-finite or negative counters degrade to unknown, never leak Infinity/NaN", () => {
		const badQueue = buildDiagnosticsSnapshot(
			healthyInput({ queue: { pendingBytes: Number.POSITIVE_INFINITY, pendingEvents: 3, lastSeq: 1, droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } }),
		);
		expect(badQueue.counters.queue.known).toBe(false);

		const badSnapshot = buildDiagnosticsSnapshot(
			healthyInput({ snapshot: { ...healthyInput().snapshot!, frames: -1 } }),
		);
		expect(badSnapshot.counters.parserSnapshot.known).toBe(false);

		const nanReplies = buildDiagnosticsSnapshot(
			healthyInput({ snapshot: { ...healthyInput().snapshot!, replies: Number.NaN } }),
		);
		expect(nanReplies.counters.parserSnapshot.known).toBe(false);
		// The serialized form is still valid JSON (no null-from-Infinity surprises).
		expect(() => JSON.parse(JSON.stringify(nanReplies))).not.toThrow();
	});

	it("overflow: queue counters flag overflow when chunks or resizes were dropped", () => {
		const snap = buildDiagnosticsSnapshot(
			healthyInput({ queue: { pendingBytes: 0, pendingEvents: 0, lastSeq: 9, droppedChunks: 2, droppedBytes: 4096, droppedResizes: 0 } }),
		);
		expect(snap.counters.queue).toMatchObject({ known: true, value: { overflowed: true, droppedChunks: 2 } });
	});

	it("redaction: no secret, command, endpoint, executable, signature, or token reaches the snapshot", () => {
		const serialized = JSON.stringify(buildDiagnosticsSnapshot(healthyInput()));
		for (const secret of ["SECRET_COMMAND", "SIGNATURE-SECRET", "/secret/home/user/bun", "/bin/bash", "127.0.0.1", "51234", "API_KEY"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("deterministic: field order in the input never changes the serialized output", () => {
		const canonical = buildDiagnosticsSnapshot(healthyInput());
		// Same facts, but the record's keys are inserted in a different order + carry extra noise.
		const shuffledRecord = {
			updatedAt: "2026-07-24T11:59:59.000Z",
			platform: "darwin",
			shell: { command: ["/bin/bash"], startSignature: "x", pid: 4243 },
			paneId: "alpha:0",
			host: { startSignature: "x", executable: "/x", pid: 4242 },
			sessionId: "alpha",
			cols: 80,
			rows: 24,
			createdAt: "2026-07-24T11:00:00.000Z",
			endpoint: { port: 51234, address: "127.0.0.1", transport: "ws" as const },
			ownership: { evidenceKind: "posix-start-signature" as const },
			runtimeVersion: "1.3.14",
			hostArtifactVersion: "1",
			protocolVersion: 1,
			schemaVersion: 1 as const,
		};
		const reordered = buildDiagnosticsSnapshot(healthyInput({ record: shuffledRecord }));
		expect(JSON.stringify(reordered)).toBe(JSON.stringify(canonical));
	});
});
