import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SESSIONS_DIR_ENV, recordFile, sessionDir, tokenFile } from "../paths";
import { isProcessAlive } from "../process-identity";
import { classifyOwnership, type OwnershipProbes, type OwnershipVerdict } from "../ownership";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	readRecord,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "../record";
import { inspectRecovery, recoverSessions, status, type RegistryDeps } from "../registry";

/** Records every process the real identity probe shells out to. */
const spawnedArgv: string[][] = [];
vi.mock("../../spawn", () => ({
	spawnSync: (argv: string[]) => {
		spawnedArgv.push(argv);
		return { success: false, stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 1 };
	},
}));

function fakeRecord(sessionId: string, hostPid: number, shellPid = hostPid): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: process.platform,
		host: { pid: hostPid, executable: "bun", startSignature: `${hostPid}@boot-1` },
		shell: { pid: shellPid, command: ["/bin/bash"], startSignature: `${shellPid}@boot-1` },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 40000 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
}

/** A dead host PID no reboot can revive. */
const GONE_PID = 2_000_000_000;

describe("native-session recovery", () => {
	let root: string;
	let prev: string | undefined;
	let launchCalls: number;

	beforeEach(() => {
		prev = process.env[NATIVE_SESSIONS_DIR_ENV];
		root = mkdtempSync(join(tmpdir(), "dev3-native-recovery-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = root;
		launchCalls = 0;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[NATIVE_SESSIONS_DIR_ENV];
		else process.env[NATIVE_SESSIONS_DIR_ENV] = prev;
		rmSync(root, { recursive: true, force: true });
	});

	/** Recovery must never launch a host: a call here fails the test loudly. */
	function deps(classify: (r: NativeSessionRecord, t: string | null) => Promise<OwnershipVerdict>): RegistryDeps {
		return {
			classify,
			resolveLaunch: (spec) => spec,
			launchHost: () => {
				launchCalls++;
				throw new Error("recovery must never launch a native host");
			},
		};
	}

	/** Identity probes standing in for `ps -o lstart` / Job Object membership. */
	function probes(alive: number[], signatures: Record<number, string>): OwnershipProbes {
		return {
			isAlive: (pid) => alive.includes(pid),
			readSignature: (pid) => signatures[pid] ?? "",
			isInJob: async () => false,
		};
	}

	it("keeps a live identity-verified session attachable across an app restart", async () => {
		writeToken("live", "tok-live");
		writeRecordAtomic(fakeRecord("live", 4242));
		const classify = (r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			classifyOwnership(r, t, probes([4242], { 4242: "4242@boot-1" }));

		const report = await inspectRecovery(deps(classify));

		expect(report.attachable).toEqual(["live"]);
		expect(report.entries[0]).toMatchObject({
			backend: "native",
			state: "attachable",
			attachable: true,
			cleanupEligible: false,
		});
		expect(report.entries[0].diagnostic).toContain("live and identity-verified");
		expect(await status("live", deps(classify))).toMatchObject({ recovery: { state: "attachable" } });
		expect(launchCalls).toBe(0);
	});

	it("classifies a machine-reboot sweep as lost and never attaches it", async () => {
		// After a reboot every recorded PID from the previous boot is gone.
		writeToken("boot-a", "tok-a");
		writeRecordAtomic(fakeRecord("boot-a", GONE_PID, GONE_PID + 1));
		writeToken("boot-b", "tok-b");
		writeRecordAtomic(fakeRecord("boot-b", GONE_PID + 2, GONE_PID + 3));
		const classify = (r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			classifyOwnership(r, t, probes([], {}));

		const report = await inspectRecovery(deps(classify));
		const single = await status("boot-a", deps(classify));

		expect(report.lost).toEqual(["boot-a", "boot-b"]);
		expect(report.attachable).toEqual([]);
		expect(report.entries.map((e) => [e.state, e.attachable, e.cleanupEligible])).toEqual([
			["lost-host-gone", false, true],
			["lost-host-gone", false, true],
		]);
		expect(report.entries[0].diagnostic).toContain("the host died or the machine restarted");
		expect(single).toMatchObject({ running: false, recovery: { state: "lost-host-gone" } });
		expect(launchCalls).toBe(0);
	});

	it("rejects a reused host PID by identity proof and leaves the unrelated process alive", async () => {
		writeToken("reused", "tok-reused");
		writeRecordAtomic(fakeRecord("reused", process.pid));
		// Same PID, different process: the recorded start signature no longer matches.
		const classify = (r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			classifyOwnership(r, t, probes([process.pid], { [process.pid]: `${process.pid}@boot-2` }));

		const report = await inspectRecovery(deps(classify));

		expect(report.entries[0]).toMatchObject({ state: "lost-pid-reused", attachable: false, cleanupEligible: true });
		expect(report.entries[0].diagnostic).toContain("unrelated process reused it and is left untouched");
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("rejects a Windows record whose PIDs left the ownership Job Object", async () => {
		const record = fakeRecord("win", 900, 901);
		record.ownership.evidenceKind = "windows-job";
		writeToken("win", "0123456789abcdef0123456789abcdef");
		writeRecordAtomic(record);
		const jobProbes: OwnershipProbes = {
			isAlive: () => true,
			readSignature: () => "",
			isInJob: async () => false, // PIDs survived the reboot, the job did not
		};
		const classify = (r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			classifyOwnership(r, t, jobProbes);

		const report = await inspectRecovery(deps(classify));

		expect(report.entries[0]).toMatchObject({ state: "lost-pid-reused", attachable: false, cleanupEligible: true });
		expect(report.attachable).toEqual([]);
	});

	it("fails closed with an actionable diagnostic for corrupt, partial, and foreign records", async () => {
		mkdirSync(sessionDir("torn"), { recursive: true });
		writeFileSync(recordFile("torn"), '{"schemaVersion": 1, "sessionId"');
		mkdirSync(sessionDir("partial"), { recursive: true });
		writeFileSync(recordFile("partial"), JSON.stringify({ schemaVersion: 1, sessionId: "partial" }));
		mkdirSync(sessionDir("newer"), { recursive: true });
		writeFileSync(recordFile("newer"), JSON.stringify({ schemaVersion: 999 }));
		mkdirSync(sessionDir("orphan"), { recursive: true });
		writeFileSync(tokenFile("orphan"), "tok-orphan");

		const report = await inspectRecovery(deps(async () => "dead"));
		const diagnostics = Object.fromEntries(report.entries.map((e) => [e.sessionId, e.diagnostic]));

		expect(report.unreadable).toEqual(["newer", "orphan", "partial", "torn"]);
		expect(report.entries.every((e) => !e.attachable && !e.cleanupEligible && e.record === null)).toBe(true);
		expect(diagnostics.torn).toContain("not valid JSON");
		expect(diagnostics.partial).toContain("missing or mistyped required fields");
		expect(diagnostics.newer).toContain("schemaVersion 999");
		expect(diagnostics.orphan).toContain("record.json is missing");
		for (const entry of report.entries) expect(entry.diagnostic).toContain(sessionDir(entry.sessionId));
	});

	it("reports a never-started or already-cleaned session as absent, not as leftover state", async () => {
		const result = await status("ghost", deps(async () => "owned"));

		expect(result).toMatchObject({
			running: false,
			recovery: { state: "absent", attachable: false, cleanupEligible: false, record: null },
		});
		expect(result.recovery.diagnostic).toContain("Nothing to recover");
		expect(result.recovery.diagnostic).not.toContain("left behind");
	});

	it("rejects an invalid session id without reading or launching anything", async () => {
		const result = await status("../escape", deps(async () => "owned"));

		expect(result).toMatchObject({
			running: false,
			recovery: { state: "unreadable", attachable: false, cleanupEligible: false, backend: "native" },
		});
		expect(result.recovery.diagnostic).toContain("invalid native session id");
	});

	it("cleanup removes only verified lost native metadata and repeats idempotently", async () => {
		writeToken("live", "tok-live");
		writeRecordAtomic(fakeRecord("live", 4242));
		writeToken("gone", "tok-gone");
		writeRecordAtomic(fakeRecord("gone", GONE_PID));
		writeRecordAtomic(fakeRecord("tokenless", GONE_PID + 1)); // lost, but unprovable → kept
		mkdirSync(sessionDir("newer"), { recursive: true });
		writeFileSync(recordFile("newer"), JSON.stringify({ schemaVersion: 999 }));
		const classify = (r: NativeSessionRecord, t: string | null): Promise<OwnershipVerdict> =>
			classifyOwnership(r, t, probes([4242], { 4242: "4242@boot-1" }));

		const first = await recoverSessions({ cleanup: true }, deps(classify));
		const second = await recoverSessions({ cleanup: true }, deps(classify));

		expect(first.removed).toEqual(["gone"]);
		expect(second.removed).toEqual([]);
		expect(first.after.entries.map((e) => [e.sessionId, e.state])).toEqual(second.after.entries.map((e) => [e.sessionId, e.state]));
		expect(first.after.attachable).toEqual(["live"]);
		expect(readRecord("live")).not.toBeNull();
		expect(readRecord("gone")).toBeNull();
		expect(readRecord("tokenless")).not.toBeNull();
		expect(first.after.entries.find((e) => e.sessionId === "tokenless")?.diagnostic).toContain(
			"cleanup token is missing",
		);
		expect(existsSync(recordFile("newer"))).toBe(true);
		expect(launchCalls).toBe(0);
	});

	it("keeps the native backend marker and never invokes tmux with the real identity probe", async () => {
		spawnedArgv.length = 0;
		writeToken("gone", "tok-gone");
		writeRecordAtomic(fakeRecord("gone", GONE_PID));
		writeToken("alive", "tok-alive");
		writeRecordAtomic(fakeRecord("alive", process.pid)); // real probe: alive PID, foreign signature

		// Default deps = the real ownership probes and the real cleanup path.
		const result = await recoverSessions({ cleanup: true });

		expect(result.before.entries.map((e) => [e.sessionId, e.backend, e.attachable])).toEqual([
			["alive", "native", false],
			["gone", "native", false],
		]);
		expect(result.before.lost).toEqual(["alive", "gone"]);
		expect(spawnedArgv.some((argv) => argv.some((arg) => arg.includes("tmux")))).toBe(false);
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(launchCalls).toBe(0);
	});

	it("inspection without cleanup removes nothing", async () => {
		writeToken("gone", "tok-gone");
		writeRecordAtomic(fakeRecord("gone", GONE_PID));

		const result = await recoverSessions({}, deps(async () => "dead"));

		expect(result.removed).toEqual([]);
		expect(readRecord("gone")).not.toBeNull();
		expect(result.before).toBe(result.after);
	});
});
