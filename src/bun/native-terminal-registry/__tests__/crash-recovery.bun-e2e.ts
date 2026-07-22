#!/usr/bin/env bun
/** Real-runtime proof for abrupt native-session host termination (seq 1236).
 * The crash phase force-kills the recorded host PID instead of asking it to stop. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../../spawn";
import { NativeSessionClient } from "../client";
import { journalFile, parserStateFile, recordFile, sessionDir, tokenFile } from "../paths";
import { readParserState } from "../parser-state";
import { isProcessAlive } from "../process-identity";
import { readRecord, readToken } from "../record";
import { cleanupStale, list, start, status, stop } from "../registry";
import { isProcessInWindowsJob, windowsJobExists } from "../windows-job";
import { sendUntilObserved } from "./command-roundtrip";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const cliEntry = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await delay(40);
	}
	return false;
}

function makeSink(client: NativeSessionClient): { text: () => string } {
	let output = "";
	const decoder = new TextDecoder();
	client.onOutput((bytes) => {
		output += decoder.decode(bytes, { stream: true });
	});
	return { text: () => output };
}

function cli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = spawnSync([process.execPath, cliEntry, ...args], {
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
	};
}

function forceKillRecordedHost(hostPid: number): void {
	if (isWindows) {
		const result = spawnSync(["taskkill.exe", "/PID", String(hostPid), "/F"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			throw new Error(`taskkill of recorded host ${hostPid} failed: ${new TextDecoder().decode(result.stderr)}`);
		}
		return;
	}
	process.kill(hostPid, "SIGKILL");
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-crash-e2e-"));
	const metadataRoot = join(root, "native-sessions");
	const shimDir = join(root, "shim");
	const tmuxWasInvoked = join(root, "tmux-was-invoked");
	const unrelatedRegistryFile = join(metadataRoot, "unrelated-sentinel");
	const sessionId = "crash-proof";
	mkdirSync(shimDir, { recursive: true });
	mkdirSync(metadataRoot, { recursive: true });
	writeFileSync(unrelatedRegistryFile, "outside every session directory\n");
	const tmuxShim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		tmuxShim,
		isWindows
			? `@echo off\r\necho called>>"${tmuxWasInvoked}"\r\nexit /b 0\r\n`
			: `#!/bin/sh\necho called >> "${tmuxWasInvoked}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(tmuxShim, 0o755);

	process.env.DEV3_NATIVE_SESSIONS_DIR = metadataRoot;
	process.env.DEV3_NATIVE_SESSION_CMD = JSON.stringify(
		isWindows ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["/bin/bash", "--norc", "--noprofile"],
	);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const sentinelCommand = isWindows
		? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 300"]
		: ["sleep", "300"];
	// Model unrelated and pre-existing tmux-owned processes without invoking tmux in the proof.
	const unrelatedSentinel = spawn(sentinelCommand, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const tmuxSentinel = spawn(sentinelCommand, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	let client: NativeSessionClient | null = null;

	console.log(`  info - platform=${process.platform} bun=${Bun.version}`);
	if (isWindows) check(Bun.version === "1.3.14", "native Windows proof runs on Bun 1.3.14");

	try {
		const started = await start(sessionId, { liveParser: true, timeoutMs: 15_000 });
		const crashedRecord = started.record;
		const crashedToken = readToken(sessionId);
		check(started.status === "started", "one isolated native session started");
		check(Boolean(crashedToken), "the crashable run published its private cleanup token");
		check(isProcessAlive(unrelatedSentinel.pid), "unrelated process sentinel is alive outside the ownership boundary");
		check(isProcessAlive(tmuxSentinel.pid), "tmux process sentinel is alive outside the ownership boundary");

		client = new NativeSessionClient();
		await client.connect(crashedRecord, crashedToken as string);
		const sink = makeSink(client);
		const sendLine = (command: string): void => client?.input(`${command}${lineEnd}`);

		sendLine(isWindows ? "powershell.exe -NoLogo -NoProfile" : "bash --norc --noprofile");
		const childMatch = isWindows
			? await sendUntilObserved({
					send: () => sendLine('Write-Output "CHILDPID[$PID]"'),
					observe: () => /CHILDPID\[(\d+)\]/.exec(sink.text()),
					attempts: 6,
					attemptTimeoutMs: 1000,
					pollIntervalMs: 30,
				})
			: await sendUntilObserved({
					send: () => sendLine('echo "CHILDPID[$$]"'),
					observe: () => /CHILDPID\[(\d+)\]/.exec(sink.text()),
					attempts: 6,
					attemptTimeoutMs: 1000,
					pollIntervalMs: 30,
				});
		const childPid = Number(childMatch?.[1]);
		check(Number.isInteger(childPid) && isProcessAlive(childPid), "root shell owns a live nested child shell");

		if (isWindows) {
			sendLine(
				`$grand = Start-Process -PassThru powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 300'); Write-Output "GRANDPID[$($grand.Id)]"`,
			);
		} else {
			sendLine("set +H");
			sendLine("sleep 300 &");
			sendLine('echo "GRANDPID[$!]"');
		}
		const grandchildMatch = await sendUntilObserved({
			send: () => {},
			observe: () => /GRANDPID\[(\d+)\]/.exec(sink.text()),
			attempts: 1,
			attemptTimeoutMs: 5000,
			pollIntervalMs: 30,
		});
		const grandchildPid = Number(grandchildMatch?.[1]);
		if (!grandchildMatch) console.error(`       terminal transcript tail: ${JSON.stringify(sink.text().slice(-2000))}`);
		check(Number.isInteger(grandchildPid) && isProcessAlive(grandchildPid), "nested child owns a live grandchild");

		if (isWindows) {
			check(await isProcessInWindowsJob(crashedToken as string, crashedRecord.host.pid), "Job Object owns the recorded host");
			check(await isProcessInWindowsJob(crashedToken as string, crashedRecord.shell.pid), "Job Object owns the root shell");
			check(await isProcessInWindowsJob(crashedToken as string, childPid), "Job Object owns the nested child");
			check(await isProcessInWindowsJob(crashedToken as string, grandchildPid), "Job Object owns the grandchild");
			check(!(await isProcessInWindowsJob(crashedToken as string, unrelatedSentinel.pid)), "Job Object excludes the unrelated sentinel");
			check(!(await isProcessInWindowsJob(crashedToken as string, tmuxSentinel.pid)), "Job Object excludes the tmux sentinel");
		}

		const journalBeforeActivity = readText(journalFile(sessionId));
		const watermarkBeforeActivity = readParserState(sessionId)?.watermarkSeq ?? -1;
		sendLine(
			isWindows
				? 'while ($true) { Write-Output "CRASH-ACTIVITY:$PID"; Start-Sleep -Milliseconds 5 }'
				: "i=0; while :; do printf 'CRASH-ACTIVITY:%s:%s\\n' \"$$\" \"$i\"; i=$((i+1)); for ((j=0; j<10000; j++)); do :; done; done",
		);
		const activePersistence = await waitUntil(() => {
			const snapshot = readParserState(sessionId);
			return (
				readText(journalFile(sessionId)) !== journalBeforeActivity &&
				Boolean(snapshot && snapshot.watermarkSeq > watermarkBeforeActivity && snapshot.health.status === "live")
			);
		});
		check(activePersistence, "journal and deferred parser were actively publishing before the crash");

		forceKillRecordedHost(crashedRecord.host.pid);
		client.close();
		client = null;
		const ownedPids = [crashedRecord.host.pid, crashedRecord.shell.pid, childPid, grandchildPid];
		const treeGone = await waitUntil(() => ownedPids.every((pid) => !isProcessAlive(pid)));
		check(treeGone, "host, shell, child, and grandchild disappear within eight seconds");
		if (isWindows) {
			check(
				await waitUntil(async () => !(await windowsJobExists(crashedToken as string))),
				"the final kill-on-close Job Object handle closed after host termination",
			);
		}
		check(isProcessAlive(unrelatedSentinel.pid), "force-killing the host leaves the unrelated sentinel alive");
		check(isProcessAlive(tmuxSentinel.pid), "force-killing the host leaves the tmux sentinel alive");

		for (const target of [recordFile(sessionId), tokenFile(sessionId), journalFile(sessionId), parserStateFile(sessionId)]) {
			writeFileSync(`${target}.${crashedRecord.host.pid}.tmp`, "{ interrupted publish", { mode: 0o600 });
		}
		check(readRecord(sessionId)?.host.pid === crashedRecord.host.pid, "partial record temp state is never published");
		check(NativeSessionClient.replayJournal(sessionId).length > 0, "partial journal temp state leaves the last complete tail readable");
		check(readParserState(sessionId)?.sessionId === sessionId, "partial parser temp state leaves the last complete snapshot readable");

		const crashedStatus = await status(sessionId);
		const crashedListing = await list();
		check(!crashedStatus.running && crashedStatus.verdict === "dead", "status reports the crashed session as dead");
		check(
			crashedListing.some((entry) => entry.sessionId === sessionId && entry.state === "dead"),
			"list keeps the crashed session visible as dead until cleanup",
		);
		const statusCli = cli(["status", sessionId]);
		const listCli = cli(["list"]);
		check(statusCli.exitCode === 0 && statusCli.stdout.includes("not running (dead)"), "a fresh CLI reports dead status honestly");
		check(listCli.exitCode === 0 && listCli.stdout.includes(`${sessionId}\tstate=dead`), "a fresh CLI lists the crashed record as dead");

		const cleanupCli = cli(["cleanup-stale"]);
		check(
			cleanupCli.exitCode === 0 && cleanupCli.stdout.includes(`removed sessionId=${sessionId}`),
			"fresh-process cleanup removes the token-matched crashed session",
		);
		check(readRecord(sessionId) === null && !existsSync(sessionDir(sessionId)), "cleanup removes record, token, journal, parser state, and owned temp files");
		check(existsSync(unrelatedRegistryFile), "cleanup preserves unrelated registry-root state");
		check(isProcessAlive(unrelatedSentinel.pid) && isProcessAlive(tmuxSentinel.pid), "cleanup signals no unrelated process");

		const restarted = await start(sessionId, { timeoutMs: 15_000 });
		const restartedToken = readToken(sessionId);
		check(restarted.status === "started", "the same stable session id starts again after cleanup");
		check(
			restarted.record.host.pid !== crashedRecord.host.pid && restartedToken !== crashedToken,
			"restart creates one new host with a new ownership token",
		);
		const duplicate = await start(sessionId, { timeoutMs: 5000 });
		check(
			duplicate.status === "already-running" && duplicate.record.shell.pid === restarted.record.shell.pid,
			"a duplicate restart observes the one new shell instead of spawning another",
		);
		check((await list()).filter((entry) => entry.sessionId === sessionId && entry.state === "running").length === 1, "list contains one running replacement");
		check(await stop(sessionId, { timeoutMs: 8000 }), "normal teardown removes the replacement session");
		check(!existsSync(tmuxWasInvoked), "the registry never invoked tmux");
	} finally {
		client?.close();
		try {
			await cleanupStale();
			await stop(sessionId, { timeoutMs: 3000 });
		} catch {
			// best-effort test cleanup
		}
		for (const sentinel of [unrelatedSentinel, tmuxSentinel]) {
			try {
				sentinel.kill();
			} catch {
				// already gone
			}
		}
		rmSync(root, { recursive: true, force: true });
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
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
