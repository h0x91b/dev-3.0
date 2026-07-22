import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SESSIONS_DIR_ENV, recordFile, sessionDir } from "../paths";
import { isProcessAlive } from "../process-identity";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	readRecord,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "../record";
import type { OwnershipVerdict } from "../ownership";
import { cleanupStale, list, start, stop, type RegistryDeps } from "../registry";

function fakeRecord(sessionId: string, hostPid: number, shellPid = process.pid): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: process.platform,
		host: { pid: hostPid, executable: "bun", startSignature: `${hostPid}@t0` },
		shell: { pid: shellPid, command: ["/bin/bash"], startSignature: `${shellPid}@t0` },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 40000 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
}

describe("native-session registry", () => {
	let root: string;
	let prev: string | undefined;
	let launchCalls: number;

	beforeEach(() => {
		prev = process.env[NATIVE_SESSIONS_DIR_ENV];
		root = mkdtempSync(join(tmpdir(), "dev3-native-registry-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = root;
		launchCalls = 0;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[NATIVE_SESSIONS_DIR_ENV];
		else process.env[NATIVE_SESSIONS_DIR_ENV] = prev;
		rmSync(root, { recursive: true, force: true });
	});

	/** A launcher that simulates a host publishing its record + private token. */
	function deps(classify: (r: NativeSessionRecord, t: string | null) => Promise<OwnershipVerdict>): RegistryDeps {
		return {
			classify,
			launchHost: (sessionId) => {
				launchCalls++;
				writeToken(sessionId, `tok-${sessionId}`);
				writeRecordAtomic(fakeRecord(sessionId, process.pid));
				return { childPid: process.pid, hasExited: () => false, earlyError: () => null };
			},
		};
	}

	it("starts a fresh session exactly once", async () => {
		const classify = vi.fn(async () => "dead" as OwnershipVerdict);
		const result = await start("alpha", { timeoutMs: 3000 }, deps(classify));
		expect(result.status).toBe("started");
		expect(result.record.sessionId).toBe("alpha");
		expect(launchCalls).toBe(1);
		expect(classify).not.toHaveBeenCalled(); // no pre-existing record to classify
	});

	it("returns already-running for a live session without launching a second host", async () => {
		writeToken("alpha", "tok-alpha");
		writeRecordAtomic(fakeRecord("alpha", process.pid));
		const result = await start("alpha", { timeoutMs: 3000 }, deps(async () => "owned"));
		expect(result.status).toBe("already-running");
		expect(launchCalls).toBe(0);
	});

	it("serialises concurrent starts of one id: exactly one wins, losers get already-running", async () => {
		const classify = async (_r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			t ? "owned" : "dead";
		const d = deps(classify);
		const results = await Promise.all([
			start("beta", { timeoutMs: 5000 }, d),
			start("beta", { timeoutMs: 5000 }, d),
			start("beta", { timeoutMs: 5000 }, d),
		]);
		expect(results.filter((r) => r.status === "started")).toHaveLength(1);
		expect(results.filter((r) => r.status === "already-running")).toHaveLength(2);
		expect(launchCalls).toBe(1);
	});

	it("replaces a stale record with a fresh host on start", async () => {
		writeToken("gamma", "old-tok");
		writeRecordAtomic(fakeRecord("gamma", 2_000_000_000));
		const result = await start("gamma", { timeoutMs: 3000 }, deps(async () => "dead"));
		expect(result.status).toBe("started");
		expect(launchCalls).toBe(1);
		expect(result.record.host.pid).toBe(process.pid);
	});

	it("lists sessions with verdicts and never leaks tokens", async () => {
		writeToken("a1", "tok-A");
		writeRecordAtomic(fakeRecord("a1", process.pid));
		writeToken("b1", "tok-B");
		writeRecordAtomic(fakeRecord("b1", 2_000_000_000));
		const classify = async (r: NativeSessionRecord): Promise<OwnershipVerdict> =>
			r.sessionId === "a1" ? "owned" : "dead";
		const listing = await list(deps(classify));
		expect(listing.map((l) => [l.sessionId, l.state])).toEqual([
			["a1", "running"],
			["b1", "dead"],
		]);
		const serialized = JSON.stringify(listing);
		expect(serialized).not.toContain("tok-A");
		expect(serialized).not.toContain("tok-B");
	});

	it("cleanup removes dead/reused token-matched state, keeps owned and unknown-schema", async () => {
		writeToken("keep", "t1");
		writeRecordAtomic(fakeRecord("keep", process.pid));
		writeToken("dead", "t2");
		writeRecordAtomic(fakeRecord("dead", process.pid));
		writeToken("reuse", "t3");
		writeRecordAtomic(fakeRecord("reuse", process.pid));
		// A record written by an unknown (newer) schema must never be deleted.
		mkdirSync(sessionDir("weird"), { recursive: true });
		writeFileSync(recordFile("weird"), JSON.stringify({ schemaVersion: 999 }));

		const classify = async (r: NativeSessionRecord): Promise<OwnershipVerdict> =>
			r.sessionId === "keep" ? "owned" : r.sessionId === "reuse" ? "reused" : "dead";
		const res = await cleanupStale(deps(classify));

		expect(res.removed.sort()).toEqual(["dead", "reuse"]);
		expect(readRecord("keep")).not.toBeNull();
		expect(readRecord("dead")).toBeNull();
		expect(readRecord("reuse")).toBeNull();
		expect(existsSync(sessionDir("weird"))).toBe(true);
		// Cleanup is purely passive: the (alive) shell PID was never signalled.
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("stop of a non-owned session drops state without signalling the PID", async () => {
		writeToken("z", "tz");
		writeRecordAtomic(fakeRecord("z", process.pid));
		const ok = await stop("z", { timeoutMs: 1000 }, deps(async () => "reused"));
		expect(ok).toBe(true);
		expect(readRecord("z")).toBeNull();
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("stop of a missing session is idempotently true", async () => {
		expect(await stop("nope", {}, deps(async () => "dead"))).toBe(true);
	});
});
