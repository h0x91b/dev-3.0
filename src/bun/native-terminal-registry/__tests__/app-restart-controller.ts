#!/usr/bin/env bun
/**
 * Short-lived APP CONTROLLER for the app-restart reattach proof (seq 1247).
 *
 * Each invocation models ONE disposable desktop-app process that comes up, does
 * exactly one job against the isolated native-session registry, prints a single
 * structured JSON verdict, and exits — WITHOUT ever stopping the detached host
 * (unless the `stop` phase is requested). Two of these in sequence prove that a
 * live native terminal session outlives full app-process turnover:
 *
 *   start-mark      controller A — start a session, write a unique shell-state
 *                   marker + capture the interactive root PID, detach the client,
 *                   and exit. The detached host survives this process.
 *   reattach-verify controller B (a genuinely fresh process) — rediscover the
 *                   session from disk alone and prove SAME host/shell/session/pane
 *                   ids + preserved shell state, a deterministic single writer,
 *                   and that no duplicate input path or resize owner exists.
 *   stop            a later app instance stops exactly the reattached session.
 *   reattach-lost   prove stale/missing metadata yields an honest lost-session
 *                   result and NEVER silently spawns a replacement shell.
 *
 * The JSON verdict is emitted on stdout, prefixed with a sentinel so the driver
 * can extract it from otherwise free-form output; human logs go to stderr.
 */

import { NativeSessionClient } from "../client";
import { isProcessAlive } from "../process-identity";
import { readRecord, readToken } from "../record";
import { start, status, stop } from "../registry";
import type { ErrorMessage, StatusReply } from "../protocol";
import {
	decodeShellLaunchSpec,
	defaultNativeShellLaunchSpec,
	NATIVE_SESSION_LAUNCH_ENV,
	type ShellLaunchSpec,
} from "../shell-launch";
import { powerShellReattachStateProbe, powerShellRootStateProbe, sendUntilObserved } from "./command-roundtrip";

const JSON_SENTINEL = "__APP_RESTART_JSON__";
const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function emit(verdict: Record<string, unknown>): void {
	process.stdout.write(`${JSON_SENTINEL}${JSON.stringify(verdict)}\n`);
}

function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

function launchSpec(): ShellLaunchSpec {
	const explicit = process.env[NATIVE_SESSION_LAUNCH_ENV];
	if (explicit) return decodeShellLaunchSpec(explicit);
	return defaultNativeShellLaunchSpec({ platform: process.platform, cwd: process.cwd(), env: process.env });
}

function makeSink(client: NativeSessionClient): { text: () => string; waitFor: (sub: string, timeoutMs?: number) => Promise<boolean> } {
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
	};
}

function makeErrorSink(client: NativeSessionClient): { count: () => number; waitFor: (code: ErrorMessage["code"], after: number) => Promise<ErrorMessage | null> } {
	const errors: ErrorMessage[] = [];
	client.onError((error) => errors.push(error));
	return {
		count: () => errors.length,
		async waitFor(code, after) {
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				const match = errors.slice(after).find((e) => e.code === code);
				if (match) return match;
				await delay(30);
			}
			return null;
		},
	};
}

const send = (client: NativeSessionClient, command: string): void => client.input(`${command}${lineEnd}`);

/** Controller A: start a session, plant a shell-state marker, detach, exit — host survives. */
async function startMark(sessionId: string, nonce: string): Promise<void> {
	const started = await start(sessionId, { launch: launchSpec(), timeoutMs: 15_000 });
	const record = started.record;
	const token = readToken(sessionId);
	if (!token) throw new Error("start-mark: session token missing after start");

	const client = new NativeSessionClient();
	const sink = makeSink(client);
	await client.connect(record, token);

	let rootPidObserved = false;
	if (isWindows) {
		const probe = powerShellRootStateProbe(nonce, record.shell.pid);
		rootPidObserved =
			(await sendUntilObserved({
				send: () => send(client, probe.command),
				observe: () => probe.observe(sink.text()),
				attempts: 4,
				attemptTimeoutMs: 1000,
				pollIntervalMs: 30,
			})) !== null;
	} else {
		send(client, "set +H");
		send(client, `export DEV3_NATIVE_STATE=${nonce}`);
		send(client, `echo "ROOTPID[$$]"`);
		const seen = await sink.waitFor(`ROOTPID[${record.shell.pid}]`);
		rootPidObserved = seen;
	}

	// Graceful detach models an orderly app quit: the host clears the writer slot
	// on socket close, so no stale writer lease can survive into the next process.
	await client.disconnect({ timeoutMs: 3000 });

	emit({
		phase: "start-mark",
		ok: rootPidObserved,
		controllerPid: process.pid,
		hostPid: record.host.pid,
		shellPid: record.shell.pid,
		sessionId: record.sessionId,
		paneId: record.paneId,
		port: record.endpoint.port,
		nonce,
		rootPidObserved,
	});
	// Exit WITHOUT stopping: the detached host (spawned unref'd) outlives us.
	process.exit(0);
}

/** Controller B (fresh process): rediscover + reattach, prove identity, state, and single-writer determinism. */
async function reattachVerify(sessionId: string, nonce: string): Promise<void> {
	const record = readRecord(sessionId);
	if (!record) throw new Error("reattach-verify: no record on disk to rediscover");

	// discover() reconnects a brand-new process from the on-disk record + token alone.
	const writer = await NativeSessionClient.discover(sessionId);
	const writerSink = makeSink(writer);
	const roleAfterDiscover = writer.getRole();
	const st: StatusReply = await writer.status();

	// Preserved shell state: the env var planted by controller A + the SAME root PID.
	let statePreserved = false;
	if (isWindows) {
		const probe = powerShellReattachStateProbe(nonce, st.shellPid);
		statePreserved =
			(await sendUntilObserved({
				send: () => send(writer, probe.command),
				observe: () => probe.observe(writerSink.text()),
				attempts: 4,
				attemptTimeoutMs: 1000,
				pollIntervalMs: 30,
			})) !== null;
	} else {
		send(writer, `echo "MARKER:$DEV3_NATIVE_STATE:$$"`);
		statePreserved = await writerSink.waitFor(`MARKER:${nonce}:${st.shellPid}`);
	}

	// Writer-lease determinism: a concurrent second client is a pure observer — its
	// input and resize are refused, so exactly one input path + one resize owner exist.
	const observer = new NativeSessionClient();
	const observerSink = makeSink(observer);
	const observerErrors = makeErrorSink(observer);
	await observer.connect(record, readToken(sessionId) as string);
	const observerRole = observer.getRole();

	const before = await writer.status();
	const rejectMarker = `OBSREJECT:${nonce}`;
	const beforeInputErrors = observerErrors.count();
	send(observer, isWindows ? `Write-Output "${rejectMarker}"` : `echo "${rejectMarker}"`);
	const inputConflict = await observerErrors.waitFor("conflict", beforeInputErrors);
	const barrier = `WRITERBARRIER:${nonce}`;
	send(writer, isWindows ? `Write-Output "${barrier}"` : `echo "${barrier}"`);
	await writerSink.waitFor(barrier);
	// The observer genuinely receives fanned-out output; it simply lacks the write path.
	const observerSawBarrier = await observerSink.waitFor(barrier);
	const observerInputRejected =
		inputConflict !== null && observerSawBarrier && !writerSink.text().includes(rejectMarker) && !observerSink.text().includes(rejectMarker);

	const beforeResizeErrors = observerErrors.count();
	observer.resize(before.cols + 11, before.rows + 7);
	const resizeConflict = await observerErrors.waitFor("conflict", beforeResizeErrors);
	const afterObserverResize = await writer.status();
	const observerResizeRejected =
		resizeConflict !== null && afterObserverResize.cols === before.cols && afterObserverResize.rows === before.rows;

	const writerCols = before.cols + 3;
	const writerRows = before.rows + 2;
	writer.resize(writerCols, writerRows);
	const afterWriterResize = await writer.status();
	const writerControlsResize = afterWriterResize.cols === writerCols && afterWriterResize.rows === writerRows;

	observer.close();
	writer.close();

	emit({
		phase: "reattach-verify",
		ok:
			roleAfterDiscover === "writer" &&
			st.writerAttached === true &&
			st.clientRole === "writer" &&
			statePreserved &&
			observerRole === "observer" &&
			observerInputRejected &&
			observerResizeRejected &&
			writerControlsResize,
		controllerPid: process.pid,
		hostPid: st.hostPid,
		shellPid: st.shellPid,
		sessionId: st.sessionId,
		paneId: st.paneId,
		roleAfterDiscover,
		writerAttached: st.writerAttached,
		clientRole: st.clientRole,
		statePreserved,
		observerRole,
		observerInputRejected,
		observerResizeRejected,
		writerControlsResize,
	});
	process.exit(0);
}

/** A later app instance stops exactly the reattached session. */
async function stopPhase(sessionId: string): Promise<void> {
	const before = readRecord(sessionId);
	const stopped = await stop(sessionId, { timeoutMs: 8000 });
	emit({
		phase: "stop",
		ok: stopped && readRecord(sessionId) === null,
		controllerPid: process.pid,
		hostPid: before?.host.pid ?? null,
		shellPid: before?.shell.pid ?? null,
		stopped,
		recordGone: readRecord(sessionId) === null,
	});
	process.exit(0);
}

/**
 * Reattach against stale/missing metadata. The reattach path uses discover/status
 * ONLY — never start — so a lost session is reported honestly and no replacement
 * shell is ever spawned.
 */
async function reattachLost(sessionId: string): Promise<void> {
	let discoverError: string | null = null;
	try {
		const client = await NativeSessionClient.discover(sessionId);
		client.close();
	} catch (err) {
		discoverError = err instanceof Error ? err.message : String(err);
	}
	const st = await status(sessionId);
	const recordBefore = readRecord(sessionId);
	const hostAlive = recordBefore ? isProcessAlive(recordBefore.host.pid) : false;

	emit({
		phase: "reattach-lost",
		// Honest lost result: discover failed OR status is not-running, and the shell
		// behind any stale record was never signalled or replaced.
		ok: !st.running && (discoverError !== null || st.verdict === "dead" || st.verdict === "reused"),
		controllerPid: process.pid,
		lost: !st.running,
		discoverFailed: discoverError !== null,
		discoverError,
		statusRunning: st.running,
		verdict: st.verdict ?? null,
		staleHostAlive: hostAlive,
	});
	process.exit(0);
}

async function main(): Promise<void> {
	const phase = process.argv[2];
	const sessionId = process.argv[3];
	const nonce = process.env.DEV3_APP_RESTART_NONCE ?? "n0";
	if (!phase || !sessionId) {
		log("usage: app-restart-controller.ts <start-mark|reattach-verify|stop|reattach-lost> <sessionId>");
		process.exit(2);
	}
	switch (phase) {
		case "start-mark":
			await startMark(sessionId, nonce);
			break;
		case "reattach-verify":
			await reattachVerify(sessionId, nonce);
			break;
		case "stop":
			await stopPhase(sessionId);
			break;
		case "reattach-lost":
			await reattachLost(sessionId);
			break;
		default:
			log(`unknown phase ${phase}`);
			process.exit(2);
	}
}

void main().catch((err) => {
	emit({ phase: process.argv[2] ?? "unknown", ok: false, error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});
