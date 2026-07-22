#!/usr/bin/env bun
/**
 * Lifecycle E2E for the persistent native-session registry (seq 1214), on the
 * REAL Bun runtime (vitest stubs the Bun global, so a live Bun.Terminal cannot
 * run there — mirrors the `test:proto-e2e` pattern). Run: `bun run test:native-registry-e2e`.
 *
 * Proves end-to-end, across TWO simultaneous sessions addressed by stable id:
 *   • start two sessions → distinct hosts/shells/ports/journals, both listed;
 *   • a launcher process exits without killing its session (started via a
 *     separate CLI subprocess), and a fresh client reattaches to the SAME host
 *     PID, shell PID, shell state, and independent journal;
 *   • a duplicate concurrent start returns already-running, never a 2nd shell;
 *   • stopping one session leaves the other, the tmux guard, and every unrelated
 *     process untouched;
 *   • stale/reused records are detected passively and cleaned up token-matched
 *     WITHOUT signalling the reused PID;
 *   • tokens never appear in list output; tmux is never invoked (PATH-shim
 *     sentinel must stay absent).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../../spawn";
import { NativeSessionClient } from "../client";
import { recordFile, tokenFile } from "../paths";
import { isProcessAlive } from "../process-identity";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	readRecord,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "../record";
import { cleanupStale, list, start, stop } from "../registry";
import { isProcessInWindowsJob, windowsJobExists } from "../windows-job";
import { powerShellReattachStateProbe, powerShellRootStateProbe, sendUntilObserved } from "./command-roundtrip";

let failures = 0;
function check(condition: boolean, msg: string): void {
	if (condition) console.log(`  ok   - ${msg}`);
	else {
		failures++;
		console.error(`  FAIL - ${msg}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";

function makeSink(client: NativeSessionClient): {
	text: () => string;
	waitFor: (sub: string, timeoutMs?: number) => Promise<boolean>;
	waitForMatch: (re: RegExp, timeoutMs?: number) => Promise<RegExpExecArray | null>;
} {
	let buf = "";
	const dec = new TextDecoder();
	client.onOutput((bytes) => {
		buf += dec.decode(bytes, { stream: true });
	});
	return {
		text: () => buf,
		async waitFor(sub, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (buf.includes(sub)) return true;
				await delay(30);
			}
			return false;
		},
		async waitForMatch(re, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const m = re.exec(buf);
				if (m) return m;
				await delay(30);
			}
			return null;
		},
	};
}

const cliEntry = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** Start a session through a SEPARATE CLI process (models a launcher that exits). */
function startViaCli(sessionId: string): { hostPid: number; shellPid: number; port: number } {
	const proc = spawnSync([process.execPath, cliEntry, "start", sessionId], {
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = new TextDecoder().decode(proc.stdout);
	const err = new TextDecoder().decode(proc.stderr);
	if (proc.exitCode !== 0) throw new Error(`cli start ${sessionId} failed (${proc.exitCode}): ${err || out}`);
	const pids = /hostPid=(\d+) shellPid=(\d+)/.exec(out);
	const port = /endpoint=ws:\/\/127\.0\.0\.1:(\d+)/.exec(out);
	if (!pids || !port) throw new Error(`cli start ${sessionId} produced no endpoint: ${out}`);
	return { hostPid: Number(pids[1]), shellPid: Number(pids[2]), port: Number(port[1]) };
}

function ghostRecord(sessionId: string, hostPid: number, shellPid: number): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: Bun.version,
		platform: process.platform,
		host: { pid: hostPid, executable: process.execPath, startSignature: "ghost@never-matches" },
		shell: { pid: shellPid, command: ["ghost"], startSignature: "ghost@never-matches" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 1 },
		ownership: { evidenceKind: isWindows ? "windows-job" : "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-registry-e2e-"));
	const metaDir = join(root, "meta");
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	const shim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		shim,
		isWindows ? `@echo off\r\necho called>>"${sentinel}"\r\nexit /b 0\r\n` : `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(shim, 0o755);

	process.env.DEV3_NATIVE_SESSIONS_DIR = metaDir;
	process.env.DEV3_NATIVE_SESSION_CMD = JSON.stringify(
		isWindows ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["/bin/bash", "--norc", "--noprofile"],
	);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const testPid = process.pid;
	// A pre-existing unrelated process the native registry must never adopt or kill.
	const tmuxGuard = spawn(
		isWindows
			? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 300"]
			: ["sleep", "300"],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);

	const send = (client: NativeSessionClient, command: string): void => client.input(`${command}${lineEnd}`);
	const nonce = `n${Date.now()}`;
	let bravo: { hostPid: number; shellPid: number; port: number } | null = null;

	try {
		// ── 1. start TWO sessions; bravo through a CLI subprocess that then exits ──
		const alpha = await start("alpha", { timeoutMs: 15_000 });
		bravo = startViaCli("bravo");

		check(alpha.status === "started" && alpha.record.host.pid !== testPid, "alpha started as a separate detached host");
		check(isProcessAlive(alpha.record.host.pid), "alpha host is alive after start() returned");
		check(isProcessAlive(bravo.hostPid), "bravo host is alive AFTER its launcher CLI process exited");
		check(alpha.record.host.pid !== bravo.hostPid, "the two sessions have distinct host PIDs");
		check(alpha.record.shell.pid !== bravo.shellPid, "the two sessions have distinct shell PIDs");
		check(alpha.record.endpoint.port !== bravo.port && bravo.port > 0, "the two sessions bind distinct loopback ports");
		check(isProcessAlive(tmuxGuard.pid), "pre-existing tmux ownership guard is alive after two starts");

		const listing = await list();
		check(listing.length === 2 && listing.every((s) => s.state === "running"), "list reports both sessions running");
		check(!JSON.stringify(listing).includes(readFileSync(tokenFile("alpha"), "utf8").trim()), "list output never leaks a token");
		check(!readFileSync(recordFile("alpha"), "utf8").includes(readFileSync(tokenFile("alpha"), "utf8").trim()), "record.json never contains the token");

		if (isWindows) {
			const aToken = readFileSync(tokenFile("alpha"), "utf8").trim();
			const bToken = readFileSync(tokenFile("bravo"), "utf8").trim();
			check(await windowsJobExists(aToken), "alpha Windows Job Object exists");
			check(await isProcessInWindowsJob(aToken, alpha.record.shell.pid), "alpha shell is in alpha's Job Object");
			check(!(await isProcessInWindowsJob(aToken, bravo.shellPid)), "bravo shell is NOT in alpha's Job Object (session isolation)");
			check(!(await isProcessInWindowsJob(bToken, alpha.record.shell.pid)), "alpha shell is NOT in bravo's Job Object (session isolation)");
		}

		// ── 2. attach alpha: set observable state + a session-unique journal marker ──
		const c1 = new NativeSessionClient();
		await c1.connect(alpha.record, readFileSync(tokenFile("alpha"), "utf8").trim());
		const s1 = makeSink(c1);
		let rootObserved: string | RegExpExecArray | null;
		let rootPidMatches: boolean;
		if (isWindows) {
			const probe = powerShellRootStateProbe(nonce, alpha.record.shell.pid);
			rootObserved = await sendUntilObserved({
				send: () => send(c1, probe.command),
				observe: () => probe.observe(s1.text()),
				attempts: 4,
				attemptTimeoutMs: 1000,
				pollIntervalMs: 30,
			});
			rootPidMatches = rootObserved !== null;
			send(c1, `Write-Output "ALPHAMARK:${nonce}"`);
		} else {
			send(c1, "set +H");
			send(c1, `export DEV3_NATIVE_STATE=${nonce}`);
			send(c1, `echo "ROOTPID[$$]"`);
			const rootMatch = await s1.waitForMatch(/ROOTPID\[(\d+)\]/);
			rootObserved = rootMatch;
			rootPidMatches = Number(rootMatch?.[1]) === alpha.record.shell.pid;
			send(c1, `echo "ALPHAMARK:${nonce}"`);
		}
		check(rootObserved !== null, "alpha client receives live shell output");
		check(rootPidMatches, "alpha interactive root reports the recorded shell PID");
		await s1.waitFor(`ALPHAMARK:${nonce}`);
		const st1 = await c1.status();
		check(st1.sessionId === "alpha" && st1.shellPid === alpha.record.shell.pid, "alpha status carries the session id + recorded shell PID");
		c1.close();

		// ── 3. attach bravo: distinct journal marker ──
		const recBravo = readRecord("bravo");
		const cB = new NativeSessionClient();
		await cB.connect(recBravo!, readFileSync(tokenFile("bravo"), "utf8").trim());
		const sB = makeSink(cB);
		send(cB, isWindows ? `Write-Output "BRAVOMARK:${nonce}"` : `echo "BRAVOMARK:${nonce}"`);
		await sB.waitFor(`BRAVOMARK:${nonce}`);
		cB.close();

		// ── 4. disconnect survival + INDEPENDENT journals ──
		await delay(400); // let the journal debounce flush
		check(isProcessAlive(alpha.record.host.pid) && isProcessAlive(alpha.record.shell.pid), "alpha host + shell survive client disconnect");
		check(isProcessAlive(bravo.hostPid) && isProcessAlive(bravo.shellPid), "bravo host + shell survive client disconnect");
		const decodeJournal = (sessionId: string): string =>
			NativeSessionClient.replayJournal(sessionId)
				.map((bytes) => new TextDecoder().decode(bytes))
				.join("");
		const alphaJournal = decodeJournal("alpha");
		const bravoJournal = decodeJournal("bravo");
		check(alphaJournal.includes(`ALPHAMARK:${nonce}`) && !alphaJournal.includes(`BRAVOMARK:${nonce}`), "alpha journal holds only alpha's output");
		check(bravoJournal.includes(`BRAVOMARK:${nonce}`) && !bravoJournal.includes(`ALPHAMARK:${nonce}`), "bravo journal holds only bravo's output");

		// ── 5. fresh client rediscovers alpha and proves PID + state preserved ──
		const c2 = await NativeSessionClient.discover("alpha");
		const s2 = makeSink(c2);
		const st2 = await c2.status();
		check(st2.hostPid === alpha.record.host.pid && st2.shellPid === alpha.record.shell.pid, "reattached client sees UNCHANGED alpha host + shell PIDs");
		let markerSeen: string | boolean | null;
		if (isWindows) {
			const probe = powerShellReattachStateProbe(nonce, alpha.record.shell.pid);
			markerSeen = await sendUntilObserved({
				send: () => send(c2, probe.command),
				observe: () => probe.observe(s2.text()),
				attempts: 4,
				attemptTimeoutMs: 1000,
				pollIntervalMs: 30,
			});
		} else {
			send(c2, `echo "MARKER:$DEV3_NATIVE_STATE:$$"`);
			markerSeen = await s2.waitFor(`MARKER:${nonce}:${alpha.record.shell.pid}`);
		}
		check(Boolean(markerSeen), "reattached client proves alpha shell STATE (env var) + PID preserved");
		check(NativeSessionClient.replayJournal("alpha").length > 0, "fresh client can replay alpha's persisted journal tail");
		c2.close();

		// ── 6. duplicate start of a live id returns already-running, no 2nd shell ──
		const dup = await start("alpha", { timeoutMs: 5000 });
		check(dup.status === "already-running", "duplicate start of a live id returns already-running");
		check(dup.record.shell.pid === alpha.record.shell.pid, "duplicate start did NOT spawn a second shell");

		// ── 7. stop alpha only; bravo + guard untouched ──
		const stoppedAlpha = await stop("alpha", { timeoutMs: 8000 });
		check(stoppedAlpha, "stop(alpha) reports success");
		check(!isProcessAlive(alpha.record.host.pid) && !isProcessAlive(alpha.record.shell.pid), "alpha host + shell terminated");
		check(readRecord("alpha") === null && !existsSync(recordFile("alpha")), "alpha registry state removed");
		check(isProcessAlive(bravo.hostPid) && isProcessAlive(bravo.shellPid), "bravo session untouched by stopping alpha");
		check(readRecord("bravo") !== null, "bravo record still present after stopping alpha");
		check(isProcessAlive(tmuxGuard.pid), "stopping alpha did not touch the tmux ownership guard");
		const alphaEndpointProbe = new NativeSessionClient();
		let alphaEndpointGone = false;
		try {
			await alphaEndpointProbe.connect(alpha.record, "irrelevant", { timeoutMs: 750 });
			alphaEndpointProbe.close();
		} catch {
			alphaEndpointGone = true;
		}
		check(alphaEndpointGone, "alpha listening endpoint is gone after stop");

		// ── 8. passive stale/reused detection + non-destructive, token-matched cleanup ──
		writeRecordAtomic(ghostRecord("ghost-dead", 2_000_000_000, 2_000_000_000));
		writeToken("ghost-dead", "ghost-dead-tok");
		writeRecordAtomic(ghostRecord("ghost-reused", tmuxGuard.pid, tmuxGuard.pid));
		writeToken("ghost-reused", "ghost-reused-tok");

		const cleanup = await cleanupStale();
		check(cleanup.removed.includes("ghost-dead"), "cleanup removed the dead-host record");
		check(cleanup.removed.includes("ghost-reused"), "cleanup removed the reused-PID record");
		check(cleanup.kept.some((s) => s.sessionId === "bravo"), "cleanup kept the live bravo session");
		check(readRecord("ghost-dead") === null && readRecord("ghost-reused") === null, "stale records erased from disk");
		check(isProcessAlive(tmuxGuard.pid), "cleanup did NOT signal the unrelated reused PID (tmux guard alive)");
		check(isProcessAlive(bravo.hostPid), "cleanup did NOT touch the live bravo host");

		// ── 9. the registry never invoked tmux ──
		check(!existsSync(sentinel), "registry NEVER invoked tmux (PATH shim sentinel absent)");
	} finally {
		try {
			await stop("bravo", { timeoutMs: 6000 });
		} catch {
			// best-effort
		}
		try {
			tmuxGuard.kill();
		} catch {
			// already gone
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch(async (err) => {
		console.error("\nERROR:", err);
		try {
			await stop("alpha", { timeoutMs: 3000 });
			await stop("bravo", { timeoutMs: 3000 });
		} catch {
			// best-effort cleanup
		}
		process.exit(1);
	});
