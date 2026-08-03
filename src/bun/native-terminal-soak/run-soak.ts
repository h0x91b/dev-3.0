#!/usr/bin/env bun
/**
 * Opt-in multi-session soak + fault-recovery gate for the native terminal host
 * (seq 1301, HOST/WIN slice of the seq 1141 tmux removal).
 *
 *   bun src/bun/native-terminal-soak/run-soak.ts [--sessions N] [--reconnects N]
 *                                                [--create-stop N] [--out PATH]
 *
 * DELIBERATELY OPT-IN. It is not a `*.test.ts`, so no vitest config collects it;
 * `bun run test` never executes it and never gets slower because it exists. Its
 * pure modules (workload / budgets / metrics / summary) ARE unit-tested there.
 *
 * What it proves, in one process-lifetime, against real detached hosts:
 *   1. N concurrent sessions survive a sustained agent-like TUI burst with input
 *      and resize interleaved, and the parser stays live with zero drops.
 *   2. Observer attach/detach and explicit writer takeover behave under load.
 *   3. R forced client disconnect/reconnect cycles recover the SAME host PID,
 *      shell PID, session id, and pane id, and reconstruct the last final screen
 *      from the bounded journal AND the persisted snapshot.
 *   4. A genuinely separate controller process does the same from a cold start.
 *   5. One host crash reaps its whole owned tree — root shell, nested child,
 *      detached grandchild — and repeated cleanup is idempotent.
 *   6. C create/stop cycles return the registry to its baseline directory count.
 *   7. Memory, journal, snapshot, registry, and process counts stay inside
 *      budgets derived from this run's own baseline (see `budgets.ts`).
 *   8. An unrelated process and a tmux sentinel survive everything, and tmux is
 *      never invoked (PATH-shim sentinel stays absent).
 *
 * No credentials, no network, no real agent binary: the workload is a
 * deterministic shell fixture. All state lives in a private temp registry root,
 * never `~/.dev3.0`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../spawn";
import { NativeSessionClient } from "../native-terminal-registry/client";
import { isProcessAlive } from "../native-terminal-registry/process-identity";
import type { NativeSessionRecord } from "../native-terminal-registry/record";
import { readToken } from "../native-terminal-registry/record";
import { cleanupStale, inspectRecovery, list, start, stop } from "../native-terminal-registry/registry";
import { isProcessInWindowsJob, windowsJobExists } from "../native-terminal-registry/windows-job";
import {
	defineShellLaunchSpec,
	encodeShellLaunchSpec,
	NATIVE_SESSION_LAUNCH_ENV,
} from "../native-terminal-registry/shell-launch";
import {
	defaultSoakBudgets,
	evaluateSoakBudgets,
	type SoakCycleSample,
	type SoakFailure,
	type SoakSessionObservation,
} from "./budgets";
import { peaksOf, sampleSession, sessionDirCount, type SessionMetricSample } from "./metrics";
import {
	buildSoakSummary,
	formatSoakSummary,
	SOAK_SUMMARY_SENTINEL,
	type SoakSessionReport,
	type SoakSummary,
} from "./summary";
import { SOAK_CONTROLLER_INPUT_ENV, SOAK_CONTROLLER_SENTINEL } from "./soak-controller";
import {
	busyForegroundCommand,
	DEFAULT_SOAK_WORKLOAD,
	doneMarker,
	longLivedGrandchildCommands,
	nestedShellCommand,
	reportPidCommand,
	SHORT_SOAK_WORKLOAD,
	soakWorkloadCommand,
	type SoakWorkloadShape,
} from "./workload";

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const controllerEntry = fileURLToPath(new URL("./soak-controller.ts", import.meta.url));

const COLS = 120;
const ROWS = 40;
/** Widest geometry the resize phase reaches — the snapshot ceiling is derived from it. */
const RESIZE_COLS_DELTA = 8;
const RESIZE_ROWS_DELTA = 4;
/** Ceiling for one burst to finish; exceeded means the host, not the budget, failed. */
const BURST_TIMEOUT_MS = 120_000;
const SHORT_BURST_TIMEOUT_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const failures: SoakFailure[] = [];
function check(condition: boolean, scope: string, code: string, reason: string): boolean {
	if (condition) {
		console.log(`  ok   - [${scope}] ${reason}`);
		return true;
	}
	failures.push({ code, scope, reason });
	console.error(`  FAIL - [${scope}] ${reason}`);
	return false;
}

function intArg(flag: string, fallback: number, max: number): number {
	const index = process.argv.indexOf(flag);
	if (index < 0) return fallback;
	const parsed = Number(process.argv[index + 1]);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new Error(`${flag} expects an integer in [1, ${max}]`);
	}
	return parsed;
}

function stringArg(flag: string, fallback: string): string {
	const index = process.argv.indexOf(flag);
	const value = index < 0 ? undefined : process.argv[index + 1];
	return value && !value.startsWith("--") ? value : fallback;
}

interface Sink {
	text: () => string;
	reset: () => void;
	waitFor: (text: string, timeoutMs: number) => Promise<boolean>;
}

function makeSink(client: NativeSessionClient): Sink {
	let output = "";
	const decoder = new TextDecoder();
	const waiters: Array<{ text: string; resolve: (matched: boolean) => void }> = [];
	client.onOutput((bytes) => {
		output += decoder.decode(bytes, { stream: true });
		for (let index = waiters.length - 1; index >= 0; index--) {
			const waiter = waiters[index]!;
			if (!output.includes(waiter.text)) continue;
			waiters.splice(index, 1);
			waiter.resolve(true);
		}
	});
	return {
		text: () => output,
		reset: () => {
			output = "";
		},
		waitFor(text, timeoutMs) {
			if (output.includes(text)) return Promise.resolve(true);
			return new Promise((resolve) => {
				const waiter = { text, resolve };
				waiters.push(waiter);
				setTimeout(() => {
					const at = waiters.indexOf(waiter);
					if (at >= 0) waiters.splice(at, 1);
					resolve(output.includes(text));
				}, timeoutMs).unref?.();
			});
		},
	};
}

/** One attached writer plus everything the soak tracks about its session. */
interface SoakSession {
	sessionId: string;
	record: NativeSessionRecord;
	token: string;
	client: NativeSessionClient;
	sink: Sink;
	samples: SessionMetricSample[];
	baseline: SoakCycleSample | null;
	sustained: SoakCycleSample | null;
	cycles: SoakCycleSample[];
	reconnectMs: number[];
	lastMarker: string;
}

function toCycleSample(sample: SessionMetricSample, reconnectMs: number | null): SoakCycleSample {
	return {
		cycle: sample.cycle,
		hostRssBytes: sample.hostRssBytes,
		snapshotBytes: sample.snapshotBytes,
		journalBytes: sample.journalBytes,
		reconnectMs,
	};
}

function send(session: SoakSession, command: string): void {
	session.client.input(`${command}${lineEnd}`);
}

/** Drive one deterministic burst and wait for its unique completion marker. */
async function burst(session: SoakSession, shape: SoakWorkloadShape, tag: string, timeoutMs: number): Promise<boolean> {
	const marker = doneMarker(tag);
	session.lastMarker = marker;
	send(session, soakWorkloadCommand(shape, tag));
	return session.sink.waitFor(marker, timeoutMs);
}

function forceKillHost(hostPid: number): void {
	if (!isWindows) {
		process.kill(hostPid, "SIGKILL");
		return;
	}
	const result = spawnSync(["taskkill.exe", "/PID", String(hostPid), "/F"], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`taskkill of host ${hostPid} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(50);
	}
}

/**
 * The interactive shell echoes the command it was sent, so the raw label appears
 * before the PID ever does. Only a digit-bearing match counts as an answer.
 */
function observedPid(text: string, label: string): number | null {
	const match = new RegExp(`${label}\\[(\\d+)\\]`).exec(text);
	const pid = match ? Number(match[1]) : Number.NaN;
	return Number.isInteger(pid) ? pid : null;
}

async function waitForPid(session: SoakSession, label: string, timeoutMs: number): Promise<number | null> {
	await waitUntil(() => observedPid(session.sink.text(), label) !== null, timeoutMs);
	return observedPid(session.sink.text(), label);
}

interface ControllerSessionVerdict {
	sessionId: string;
	discovered: boolean;
	paneId: string | null;
	hostPid: number | null;
	shellPid: number | null;
	role: string | null;
	markerInSnapshot: boolean;
	markerInReplay: boolean;
	error: string | null;
}

/** Run one cold controller process and lift its single JSON verdict. */
function runFreshController(sessionIds: string[], marker: string): {
	controllerPid: number | null;
	sessions: ControllerSessionVerdict[];
	stderr: string;
} {
	const proc = spawnSync([process.execPath, controllerEntry], {
		env: { ...process.env, [SOAK_CONTROLLER_INPUT_ENV]: JSON.stringify({ sessionIds, marker }) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout);
	const stderr = new TextDecoder().decode(proc.stderr);
	for (const line of stdout.split("\n")) {
		if (!line.startsWith(SOAK_CONTROLLER_SENTINEL)) continue;
		const parsed = JSON.parse(line.slice(SOAK_CONTROLLER_SENTINEL.length)) as {
			controllerPid: number;
			sessions: ControllerSessionVerdict[];
		};
		return { controllerPid: parsed.controllerPid, sessions: parsed.sessions, stderr };
	}
	return { controllerPid: null, sessions: [], stderr };
}

async function main(): Promise<SoakSummary> {
	const startedAt = Date.now();
	const sessionCount = intArg("--sessions", 4, 16);
	const reconnectCycles = intArg("--reconnects", 24, 200);
	const createStopCycles = intArg("--create-stop", 6, 50);
	const root = mkdtempSync(join(tmpdir(), "dev3-native-soak-"));
	const metaDir = join(root, "native-sessions");
	const shimDir = join(root, "shim");
	const tmuxWasInvoked = join(root, "tmux-was-invoked");
	mkdirSync(metaDir, { recursive: true });
	mkdirSync(shimDir, { recursive: true });
	const tmuxShim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		tmuxShim,
		isWindows
			? `@echo off\r\necho called>>"${tmuxWasInvoked}"\r\nexit /b 0\r\n`
			: `#!/bin/sh\necho called >> "${tmuxWasInvoked}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(tmuxShim, 0o755);

	process.env.DEV3_NATIVE_SESSIONS_DIR = metaDir;
	const launch = defineShellLaunchSpec({
		executable: isWindows ? "powershell.exe" : "/bin/bash",
		argv: isWindows ? ["-NoLogo", "-NoProfile", "-NoExit"] : ["--norc", "--noprofile"],
		cwd: root,
		env: {},
	});
	process.env[NATIVE_SESSION_LAUNCH_ENV] = encodeShellLaunchSpec(launch);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const sentinelCommand = isWindows
		? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 1800"]
		: ["sleep", "1800"];
	const unrelatedSentinel = spawn(sentinelCommand, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const tmuxSentinel = spawn(sentinelCommand, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

	console.log(`  info - platform=${process.platform}/${process.arch} bun=${Bun.version} runtime=${basename(process.execPath)}`);
	console.log(`  info - sessions=${sessionCount} reconnects=${reconnectCycles} createStop=${createStopCycles} root=<temp>`);
	if (isWindows) {
		check(Bun.version === "1.3.14", "harness", "bun-version", "native Windows soak runs on Bun 1.3.14");
	}

	const sessions: SoakSession[] = [];
	const clientRssByCycle: number[] = [];
	let registryDirsBaseline = 0;
	let registryDirsAfterChurn = 0;
	let registryDirsFinal = 0;
	let ownedPidsTrackedAtCrash = 0;
	let ownedPidsAliveAfterCrash = 0;
	let ownedPidsAliveAfterTeardown = 0;
	let cleanupIsIdempotent = false;
	let crashedSessionsClassifiedLost = 0;
	let reconnectsAttempted = 0;
	let reconnectsWithStableIdentity = 0;
	let reconnectsWithCorrectFinalScreen = 0;
	let freshControllerReattached = false;
	let freshControllerScreenCorrect = false;

	try {
		// ── 1. fan out N concurrent sessions and warm every shell ──────────────
		for (let index = 0; index < sessionCount; index++) {
			const sessionId = `soak-${index}`;
			const started = await start(sessionId, { launch, captureMode: "semantic", cols: COLS, rows: ROWS, timeoutMs: 20_000 });
			const token = readToken(sessionId);
			if (started.status !== "started" || !token) throw new Error(`session ${sessionId} did not start`);
			const client = new NativeSessionClient();
			await client.connect(started.record, token);
			sessions.push({
				sessionId,
				record: started.record,
				token,
				client,
				sink: makeSink(client),
				samples: [],
				baseline: null,
				sustained: null,
				cycles: [],
				reconnectMs: [],
				lastMarker: "",
			});
		}
		check(sessions.length === sessionCount, "harness", "fan-out", `${sessionCount} concurrent native sessions started`);
		check(
			new Set(sessions.map((session) => session.record.host.pid)).size === sessionCount,
			"harness",
			"distinct-hosts",
			"every session owns its own detached host process",
		);

		const warmed = await Promise.all(
			sessions.map((session) => burst(session, SHORT_SOAK_WORKLOAD, `warm-${session.sessionId}`, SHORT_BURST_TIMEOUT_MS)),
		);
		check(warmed.every(Boolean), "harness", "warmup", "every shell completed its warm-up burst");
		// The snapshot writer is debounced and rate-limited; without waiting for the
		// first publish the cold baseline sample would report unknown memory.
		check(
			await waitUntil(() => sessions.every((session) => sampleSession(session.sessionId, 0).hostRssBytes !== null), 20_000),
			"harness",
			"baseline-published",
			"every host published its first memory sample before the baseline was taken",
		);
		for (const session of sessions) {
			const sample = sampleSession(session.sessionId, 0);
			session.samples.push(sample);
			session.baseline = toCycleSample(sample, null);
		}
		// ── 2. sustained agent-like output with interleaved input and resize ───
		const sustainedRuns = sessions.map(async (session, index) => {
			const running = burst(session, DEFAULT_SOAK_WORKLOAD, `burst-${index}`, BURST_TIMEOUT_MS);
			for (const [cols, rows] of [
				[COLS + RESIZE_COLS_DELTA, ROWS + RESIZE_ROWS_DELTA],
				[COLS - RESIZE_COLS_DELTA, ROWS - RESIZE_ROWS_DELTA],
				[COLS, ROWS],
			] as const) {
				await delay(200);
				session.client.resize(cols, rows);
			}
			return running;
		});
		check((await Promise.all(sustainedRuns)).every(Boolean), "harness", "sustained-output", "every session finished the sustained high-output burst under concurrent resizes");
		for (const session of sessions) {
			const live = await session.client.status({ timeoutMs: 5_000 });
			check(
				live.alive && live.cols === COLS && live.rows === ROWS,
				session.sessionId,
				"resize-settled",
				`session stayed alive and settled back to ${COLS}x${ROWS}`,
			);
		}
		// Give the debounced snapshot writer a cadence window to publish the peak.
		await delay(1_500);
		for (const session of sessions) {
			const sample = sampleSession(session.sessionId, 1);
			session.samples.push(sample);
			session.sustained = toCycleSample(sample, null);
		}

		// ── 3. observer attach/detach and explicit writer takeover ─────────────
		const host = sessions[0]!;
		const observer = new NativeSessionClient();
		const observerSink = makeSink(observer);
		await observer.connect(host.record, host.token);
		check(observer.getRole() === "observer", host.sessionId, "observer-role", "a second concurrent client attaches as observer, not writer");
		check(
			await observerSink.waitFor(host.lastMarker, 15_000),
			host.sessionId,
			"observer-replay",
			"the observer reconstructs the last final screen from the bounded journal",
		);
		let observerRejected = false;
		observer.onError((error) => {
			if (error.code === "conflict") observerRejected = true;
		});
		observer.input(`echo SOAK-OBSERVER-INPUT${lineEnd}`);
		await delay(500);
		check(observerRejected, host.sessionId, "observer-input-refused", "observer input is refused with a conflict instead of reaching the PTY");
		await host.client.releaseWriter();
		const claimed = await observer.claimWriter();
		check(claimed.role === "writer", host.sessionId, "writer-takeover", "an explicit claim transfers the writer lease under load");
		await observer.releaseWriter();
		observer.close();
		await delay(300);
		const reclaimed = await host.client.claimWriter();
		check(reclaimed.role === "writer", host.sessionId, "writer-return", "the original client reclaims the writer lease after the observer detaches");

		// ── 4. forced disconnect / reconnect cycles ────────────────────────────
		for (let cycle = 1; cycle <= reconnectCycles; cycle++) {
			for (const session of sessions) session.client.close();
			await delay(400);
			for (const session of sessions) {
				reconnectsAttempted++;
				const previousMarker = session.lastMarker;
				const before = Date.now();
				const client = new NativeSessionClient();
				await client.connect(session.record, session.token);
				const reconnectMs = Date.now() - before;
				session.client = client;
				session.sink = makeSink(client);
				session.reconnectMs.push(reconnectMs);
				if (client.getRole() !== "writer") await client.claimWriter();
				const live = await client.status({ timeoutMs: 5_000 });
				const stable =
					live.hostPid === session.record.host.pid &&
					live.shellPid === session.record.shell.pid &&
					live.sessionId === session.sessionId &&
					live.paneId === session.record.paneId;
				if (stable) reconnectsWithStableIdentity++;
				check(stable, session.sessionId, "reconnect-identity", `cycle ${cycle} reattached to the same host, shell, session, and pane`);
				const replayed = await session.sink.waitFor(previousMarker, 10_000);
				if (replayed) reconnectsWithCorrectFinalScreen++;
				check(replayed, session.sessionId, "reconnect-screen", `cycle ${cycle} reconstructed the previous final screen from the journal tail`);
				check(
					await burst(session, SHORT_SOAK_WORKLOAD, `cyc${cycle}-${session.sessionId}`, SHORT_BURST_TIMEOUT_MS),
					session.sessionId,
					"reconnect-liveness",
					`cycle ${cycle} drove new output through the reattached writer`,
				);
			}
			await delay(1_500);
			for (const session of sessions) {
				const sample = sampleSession(session.sessionId, cycle + 1);
				session.samples.push(sample);
				session.cycles.push(toCycleSample(sample, session.reconnectMs[session.reconnectMs.length - 1] ?? null));
			}
			clientRssByCycle.push(process.memoryUsage().rss);
			const hostRss = sessions
				.map((session) => session.cycles[session.cycles.length - 1]?.hostRssBytes ?? 0)
				.map((bytes) => (bytes / (1024 * 1024)).toFixed(1))
				.join("/");
			console.log(
				`  info - reconnect cycle ${cycle}/${reconnectCycles} clientRss=${(clientRssByCycle[clientRssByCycle.length - 1]! / (1024 * 1024)).toFixed(1)}MiB hostRss=${hostRss}MiB`,
			);
		}

		// ── 5. a genuinely separate controller process reattaches cold ─────────
		for (const session of sessions) session.client.close();
		await delay(400);
		const controllerMarker = sessions[0]!.lastMarker;
		const controller = runFreshController([sessions[0]!.sessionId], controllerMarker);
		if (controller.stderr.trim()) console.log(`       [controller stderr] ${controller.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		const controllerVerdict = controller.sessions[0] ?? null;
		freshControllerReattached =
			controller.controllerPid !== null &&
			controller.controllerPid !== process.pid &&
			controllerVerdict?.discovered === true &&
			controllerVerdict.hostPid === sessions[0]!.record.host.pid &&
			controllerVerdict.shellPid === sessions[0]!.record.shell.pid &&
			controllerVerdict.paneId === sessions[0]!.record.paneId;
		check(freshControllerReattached, sessions[0]!.sessionId, "fresh-controller-identity", "a cold controller process rediscovered the same live session identity from disk");
		freshControllerScreenCorrect = controllerVerdict?.markerInSnapshot === true && controllerVerdict.markerInReplay === true;
		check(freshControllerScreenCorrect, sessions[0]!.sessionId, "fresh-controller-screen", "the cold controller reconstructed the same final screen from both the snapshot and the journal");
		for (const session of sessions) {
			const client = new NativeSessionClient();
			await client.connect(session.record, session.token);
			if (client.getRole() !== "writer") await client.claimWriter();
			session.client = client;
			session.sink = makeSink(client);
		}

		// ── 6. host crash reaps the whole owned tree, cleanup is idempotent ────
		const victim = sessions[sessions.length - 1]!;
		send(victim, nestedShellCommand());
		await delay(1_500);
		send(victim, reportPidCommand("SOAKCHILD"));
		const childPid = await waitForPid(victim, "SOAKCHILD", 20_000);
		for (const command of longLivedGrandchildCommands("SOAKGRAND", 1800)) send(victim, command);
		const grandchildPid = await waitForPid(victim, "SOAKGRAND", 20_000);
		// Crash the host while the descendant tree is ACTIVE — the realistic shape,
		// and the only one in which POSIX hangup propagation is observable at all
		// (decision 172). An idle nested shell orphans its background job instead.
		send(victim, busyForegroundCommand("SOAKBUSY"));
		check(
			await victim.sink.waitFor("SOAKBUSY:", 20_000),
			victim.sessionId,
			"crash-activity",
			"the owned tree is actively producing output at the moment the host dies",
		);
		check(
			childPid !== null && grandchildPid !== null && isProcessAlive(childPid) && isProcessAlive(grandchildPid),
			victim.sessionId,
			"nested-descendants",
			"the root shell owns a live nested child and a detached grandchild",
		);
		const ownedPids = [victim.record.host.pid, victim.record.shell.pid, childPid, grandchildPid].filter(
			(pid): pid is number => typeof pid === "number",
		);
		ownedPidsTrackedAtCrash = ownedPids.length;
		if (isWindows) {
			const owned = await Promise.all(ownedPids.map((pid) => isProcessInWindowsJob(victim.token, pid)));
			check(owned.every(Boolean), victim.sessionId, "windows-job-membership", "the token-named Job Object owns every process in the tree");
			check(
				!(await isProcessInWindowsJob(victim.token, unrelatedSentinel.pid)) &&
					!(await isProcessInWindowsJob(victim.token, tmuxSentinel.pid)),
				victim.sessionId,
				"windows-job-exclusion",
				"the Job Object excludes the unrelated and tmux sentinels",
			);
		}
		forceKillHost(victim.record.host.pid);
		victim.client.close();
		const reaped = await waitUntil(() => ownedPids.every((pid) => !isProcessAlive(pid)), 20_000);
		ownedPidsAliveAfterCrash = ownedPids.filter((pid) => isProcessAlive(pid)).length;
		const roles = ["host", "shell", "nested-child", "grandchild"];
		const survivorRoles = ownedPids.map((pid, index) => ({ pid, role: roles[index] ?? "owned" })).filter(({ pid }) => isProcessAlive(pid));
		check(
			reaped,
			victim.sessionId,
			"crash-reap",
			reaped
				? `the crash reaped all ${ownedPids.length} owned processes, including the detached grandchild`
				: `the crash left ${survivorRoles.map(({ role }) => role).join(", ")} alive out of ${ownedPids.length} owned processes`,
		);
		if (isWindows) {
			check(
				await waitUntil(async () => !(await windowsJobExists(victim.token)), 20_000),
				victim.sessionId,
				"windows-job-closed",
				"the kill-on-close Job Object handle closed after host termination",
			);
		}
		check(isProcessAlive(unrelatedSentinel.pid) && isProcessAlive(tmuxSentinel.pid), victim.sessionId, "crash-sentinels", "the crash left the unrelated and tmux sentinels alive");
		const recovery = await inspectRecovery();
		crashedSessionsClassifiedLost = recovery.lost.filter((id) => id === victim.sessionId).length;
		check(crashedSessionsClassifiedLost === 1, victim.sessionId, "crash-classified-lost", "the crashed session is classified lost rather than silently revived");
		const firstCleanup = await cleanupStale();
		const secondCleanup = await cleanupStale();
		cleanupIsIdempotent = firstCleanup.removed.includes(victim.sessionId) && secondCleanup.removed.length === 0;
		check(cleanupIsIdempotent, victim.sessionId, "cleanup-idempotent", "cleanup removed the crashed session once and the repeat run was a no-op");

		// ── 7. repeated create/stop churn returns to the baseline ──────────────
		const churnId = "soak-churn";
		// The reference is the count right before churn — the crash phase already
		// removed the victim, so the fan-out count is not the honest comparison.
		registryDirsBaseline = sessionDirCount();
		const dirsBeforeChurn = registryDirsBaseline;
		for (let cycle = 1; cycle <= createStopCycles; cycle++) {
			const started = await start(churnId, { launch, captureMode: "semantic", cols: COLS, rows: ROWS, timeoutMs: 20_000 });
			const token = readToken(churnId);
			if (!token) throw new Error(`churn cycle ${cycle} published no token`);
			const client = new NativeSessionClient();
			const sink = makeSink(client);
			await client.connect(started.record, token);
			const tag = `churn${cycle}`;
			client.input(`${soakWorkloadCommand(SHORT_SOAK_WORKLOAD, tag)}${lineEnd}`);
			const done = await sink.waitFor(doneMarker(tag), SHORT_BURST_TIMEOUT_MS);
			client.close();
			const stopped = await stop(churnId, { timeoutMs: 15_000 });
			const gone = await waitUntil(
				() => !isProcessAlive(started.record.host.pid) && !isProcessAlive(started.record.shell.pid),
				10_000,
			);
			if (!done || !stopped || !gone) {
				check(false, churnId, "create-stop-cycle", `create/stop cycle ${cycle} failed (burst=${done} stop=${stopped} reaped=${gone})`);
			}
		}
		registryDirsAfterChurn = sessionDirCount();
		check(
			registryDirsAfterChurn === dirsBeforeChurn,
			"harness",
			"create-stop-churn",
			`${createStopCycles} create/stop cycles returned the registry to ${dirsBeforeChurn} session directories`,
		);

		// ── 8. explicit teardown of everything that is left ────────────────────
		const survivingPids: number[] = [];
		for (const session of sessions) {
			session.client.close();
			survivingPids.push(session.record.host.pid, session.record.shell.pid);
			check(await stop(session.sessionId, { timeoutMs: 15_000 }), session.sessionId, "stop", "explicit stop succeeded");
		}
		await waitUntil(() => survivingPids.every((pid) => !isProcessAlive(pid)), 20_000);
		ownedPidsAliveAfterTeardown = survivingPids.filter((pid) => isProcessAlive(pid)).length;
		registryDirsFinal = sessionDirCount();
		check(ownedPidsAliveAfterTeardown === 0, "harness", "teardown-processes", "no owned host or shell survived teardown");
		check(registryDirsFinal === 0, "harness", "teardown-registry", "no session directory survived teardown");
		check((await list()).length === 0, "harness", "teardown-listing", "the registry lists no session after teardown");
		check(isProcessAlive(unrelatedSentinel.pid), "harness", "unrelated-sentinel", "the unrelated process survived the entire soak");
		check(isProcessAlive(tmuxSentinel.pid), "harness", "tmux-sentinel", "the tmux sentinel process survived the entire soak");
		check(!existsSync(tmuxWasInvoked), "harness", "tmux-never-invoked", "the entire soak NEVER invoked tmux");

		// ── 9. budgets over the collected evidence ─────────────────────────────
		const observations = {
			sessions: sessions.map<SoakSessionObservation>((session) => {
				const peaks = peaksOf(session.samples);
				return {
					sessionId: session.sessionId,
					baseline: session.baseline!,
					sustained: session.sustained!,
					cycles: session.cycles,
					parserHealth: peaks.parserHealthFinal,
					droppedChunks: peaks.droppedChunks,
					droppedBytes: peaks.droppedBytes,
					droppedResizes: peaks.droppedResizes,
				};
			}),
			clientRssByCycle,
			registryDirsBaseline,
			registryDirsAfterChurn,
			registryDirsFinal,
			ownedPidsAliveAfterCrash,
			ownedPidsAliveAfterTeardown,
		};
		// The ceiling follows the WIDEST geometry the resize phase reached.
		const budgets = defaultSoakBudgets({ cols: COLS + RESIZE_COLS_DELTA, rows: ROWS + RESIZE_ROWS_DELTA });
		for (const failure of evaluateSoakBudgets(observations, budgets)) {
			failures.push(failure);
			console.error(`  FAIL - [${failure.scope}] ${failure.reason}`);
		}

		const perSession: SoakSessionReport[] = sessions.map((session) => ({
			sessionId: session.sessionId,
			peaks: peaksOf(session.samples),
			hostRssBaselineBytes: session.baseline?.hostRssBytes ?? null,
			hostRssSustainedBytes: session.sustained?.hostRssBytes ?? null,
			hostRssByCycle: session.cycles.map((entry) => entry.hostRssBytes),
			reconnectMs: session.reconnectMs,
		}));
		return buildSoakSummary({
			platform: process.platform,
			arch: process.arch,
			bunVersion: Bun.version,
			runtimeExecutable: basename(process.execPath),
			elapsedMs: Date.now() - startedAt,
			sessions: sessionCount,
			reconnectCycles,
			workload: DEFAULT_SOAK_WORKLOAD,
			cols: COLS,
			rows: ROWS,
			perSession,
			clientRssByCycle,
			recovery: {
				reconnectsAttempted,
				reconnectsWithStableIdentity,
				reconnectsWithCorrectFinalScreen,
				freshControllerReattached,
				freshControllerScreenCorrect,
				crashedSessionsClassifiedLost,
			},
			cleanup: {
				ownedPidsTrackedAtCrash,
				ownedPidsAliveAfterCrash,
				cleanupIsIdempotent,
				createStopCycles,
				registryDirsBaseline,
				registryDirsAfterChurn,
				registryDirsFinal,
				ownedPidsAliveAfterTeardown,
				unrelatedSentinelSurvived: isProcessAlive(unrelatedSentinel.pid),
				tmuxSentinelSurvived: isProcessAlive(tmuxSentinel.pid),
				tmuxInvoked: existsSync(tmuxWasInvoked),
			},
			failures,
		});
	} finally {
		for (const session of sessions) {
			try {
				session.client.close();
				await stop(session.sessionId, { timeoutMs: 5_000 });
			} catch {
				// best-effort teardown
			}
		}
		try {
			await stop("soak-churn", { timeoutMs: 5_000 });
			await cleanupStale();
		} catch {
			// best-effort teardown
		}
		for (const sentinel of [unrelatedSentinel, tmuxSentinel]) {
			try {
				sentinel.kill();
			} catch {
				// already gone
			}
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort teardown
		}
	}
}

const outFile = stringArg("--out", join(tmpdir(), "dev3-native-soak-summary.json"));
main()
	.then((summary) => {
		const json = JSON.stringify(summary);
		writeFileSync(outFile, `${json}\n`);
		console.log(`\n${SOAK_SUMMARY_SENTINEL}${json}`);
		console.log(formatSoakSummary(summary));
		console.log(`summary written to ${outFile}`);
		if (!summary.ok) for (const failure of summary.failures) console.error(`  reason [${failure.code}] ${failure.scope}: ${failure.reason}`);
		process.exit(summary.ok ? 0 : 1);
	})
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
