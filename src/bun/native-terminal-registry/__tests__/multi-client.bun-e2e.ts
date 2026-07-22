#!/usr/bin/env bun
/** Real-runtime two-client writer/observer lifecycle proof (seq 1237). */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { NativeSessionClient } from "../client";
import { recordFile, tokenFile } from "../paths";
import { isProcessAlive } from "../process-identity";
import type { ErrorMessage } from "../protocol";
import { readRecord } from "../record";
import { start, stop } from "../registry";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";

function makeSink(client: NativeSessionClient): {
	text: () => string;
	waitFor: (text: string) => Promise<boolean>;
} {
	let output = "";
	const waiters: Array<{ text: string; resolve: (matched: boolean) => void }> = [];
	const decoder = new TextDecoder();
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
		waitFor(text) {
			if (output.includes(text)) return Promise.resolve(true);
			return new Promise((resolve) => waiters.push({ text, resolve }));
		},
	};
}

function makeErrorSink(client: NativeSessionClient): {
	all: () => ErrorMessage[];
	waitFor: (code: ErrorMessage["code"], after?: number) => Promise<ErrorMessage>;
} {
	const errors: ErrorMessage[] = [];
	const waiters: Array<{
		code: ErrorMessage["code"];
		after: number;
		resolve: (error: ErrorMessage) => void;
	}> = [];
	client.onError((error) => {
		errors.push(error);
		for (let index = waiters.length - 1; index >= 0; index--) {
			const waiter = waiters[index]!;
			if (errors.length <= waiter.after || error.code !== waiter.code) continue;
			waiters.splice(index, 1);
			waiter.resolve(error);
		}
	});
	return {
		all: () => errors,
		waitFor(code, after = 0) {
			const match = errors.slice(after).find((error) => error.code === code);
			if (match) return Promise.resolve(match);
			return new Promise((resolve) => waiters.push({ code, after, resolve }));
		},
	};
}

function send(client: NativeSessionClient, command: string): void {
	client.input(`${command}${lineEnd}`);
}

function outputCommand(...lines: string[]): string {
	if (isWindows) return lines.map((line) => `Write-Output "${line}"`).join("; ");
	return `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}`;
}

function historyCommand(nonce: string): string {
	const prefixes = ["HISTORY-START-", "HISTORY-BODY-", "HISTORY-END-"];
	if (isWindows) return prefixes.map((prefix) => `Write-Output ("${prefix}" + "${nonce}")`).join("; ");
	return prefixes.map((prefix) => `printf '%s%s\\n' '${prefix}' '${nonce}'`).join("; ");
}

function segment(text: string, start: string, end: string): string | null {
	const from = text.indexOf(start);
	if (from < 0) return null;
	const through = text.indexOf(end, from);
	if (through < 0) return null;
	return text.slice(from, through + end.length);
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function disconnect(client: NativeSessionClient): Promise<void> {
	const disconnected = new Promise<void>((resolve) => client.onDisconnect(resolve));
	client.close();
	return disconnected;
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-multi-client-e2e-"));
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

	const nonce = `n${Date.now()}`;
	const sessionId = "multi-client";
	let restartedHostPid: number | null = null;

	try {
		const started = await start(sessionId, { timeoutMs: 15_000 });
		const token = readFileSync(tokenFile(sessionId), "utf8").trim();
		const seed = new NativeSessionClient();
		const seedSink = makeSink(seed);
		await seed.connect(started.record, token);
		const historyStart = `HISTORY-START-${nonce}`;
		const historyEnd = `HISTORY-END-${nonce}`;
		send(seed, historyCommand(nonce));
		await seedSink.waitFor(historyEnd);
		const expectedHistoryOccurrences = occurrences(seedSink.text(), historyEnd);
		await disconnect(seed);

		const clients = [new NativeSessionClient(), new NativeSessionClient()];
		const sinks = clients.map(makeSink);
		const errorSinks = clients.map(makeErrorSink);

		await Promise.all(clients.map((client) => client.connect(started.record, token)));
		await Promise.all(sinks.map((sink) => sink.waitFor(historyEnd)));
		check(
			sinks.every((sink) => occurrences(sink.text(), historyEnd) === expectedHistoryOccurrences),
			"both fresh clients reconstruct every pre-attach PTY byte exactly once",
		);
		check(
			segment(sinks[0]!.text(), historyStart, historyEnd) === segment(sinks[1]!.text(), historyStart, historyEnd),
			"both fresh clients receive the same reconstructed state before live output",
		);
		const writerIndex = clients.findIndex((client) => client.getRole() === "writer");
		const observerIndex = clients.findIndex((client) => client.getRole() === "observer");
		check(writerIndex >= 0 && observerIndex >= 0 && writerIndex !== observerIndex, "two concurrent attaches produce one writer and one observer");
		const writer = clients[writerIndex]!;
		const observer = clients[observerIndex]!;
		const writerSink = sinks[writerIndex]!;
		const observerSink = sinks[observerIndex]!;
		const observerErrors = errorSinks[observerIndex]!;

		const syncStart = `SYNC-START-${nonce}`;
		const syncBody = `SYNC-BODY-${nonce}`;
		const syncEnd = `SYNC-END-${nonce}`;
		send(writer, outputCommand(syncStart, syncBody, syncEnd));
		const writerSawSync = await writerSink.waitFor(syncEnd);
		const observerSawSync = await observerSink.waitFor(syncEnd);
		check(writerSawSync && observerSawSync, "writer and observer both receive the same live PTY output");
		check(
			segment(writerSink.text(), syncStart, syncEnd) === segment(observerSink.text(), syncStart, syncEnd),
			"the shared incremental output segment is byte-equivalent for both clients",
		);

		const rejectedMarker = `OBSERVER-INPUT-${nonce}`;
		const beforeInputErrors = observerErrors.all().length;
		send(observer, outputCommand(rejectedMarker));
		const inputConflict = await observerErrors.waitFor("conflict", beforeInputErrors);
		const inputBarrier = `INPUT-BARRIER-${nonce}`;
		send(writer, outputCommand(inputBarrier));
		await Promise.all([writerSink.waitFor(inputBarrier), observerSink.waitFor(inputBarrier)]);
		check(inputConflict.message?.includes("PTY input") === true, "observer binary input receives the compact conflict error");
		check(!writerSink.text().includes(rejectedMarker) && !observerSink.text().includes(rejectedMarker), "rejected observer input never reaches the PTY");
		check(
			(await observer.status()).alive && (await writer.status()).alive && isProcessAlive(started.record.shell.pid),
			"observer, writer, host, and shell remain live after rejected input",
		);

		const beforeResize = await writer.status();
		const observerCols = beforeResize.cols + 17;
		const observerRows = beforeResize.rows + 9;
		const beforeResizeErrors = observerErrors.all().length;
		observer.resize(observerCols, observerRows);
		const resizeConflict = await observerErrors.waitFor("conflict", beforeResizeErrors);
		const unchanged = await writer.status();
		check(resizeConflict.message?.includes("resize") === true, "observer resize receives conflict without closing either client");
		check(
			unchanged.cols === beforeResize.cols && unchanged.rows === beforeResize.rows,
			"observer viewport changes leave the shared PTY dimensions unchanged",
		);

		const writerCols = beforeResize.cols + 3;
		const writerRows = beforeResize.rows + 2;
		writer.resize(writerCols, writerRows);
		const resized = await writer.status();
		check(resized.cols === writerCols && resized.rows === writerRows, "the current writer controls the PTY dimensions");

		const released = await writer.releaseWriter();
		check(released.role === "observer" && !released.writerAttached, "writer release leaves one explicit vacant writer slot");
		const claims = await Promise.allSettled([clients[0]!.claimWriter(), clients[1]!.claimWriter()]);
		const winners = claims.map((result, index) => ({ result, index })).filter(({ result }) => result.status === "fulfilled");
		check(winners.length === 1, "two simultaneous claims produce exactly one winner");
		const takeoverIndex = winners[0]?.index ?? 0;
		const losingIndex = takeoverIndex === 0 ? 1 : 0;
		const takeover = clients[takeoverIndex]!;
		const remainingObserver = clients[losingIndex]!;
		check(takeover.getRole() === "writer" && remainingObserver.getRole() === "observer", "claim result agrees with both client roles");
		const transferred = await takeover.status();
		check(
			transferred.cols === writerCols && transferred.rows === writerRows,
			"release and atomic claim do not change or corrupt the PTY dimensions",
		);
		const takeoverCols = writerCols + 4;
		const takeoverRows = writerRows + 3;
		takeover.resize(takeoverCols, takeoverRows);
		const takeoverSize = await takeover.status();
		check(
			takeoverSize.cols === takeoverCols && takeoverSize.rows === takeoverRows,
			"resize control follows the claim winner",
		);

		const takeoverMarker = `TAKEOVER-${nonce}`;
		send(takeover, outputCommand(takeoverMarker));
		check(
			(await sinks[0]!.waitFor(takeoverMarker)) && (await sinks[1]!.waitFor(takeoverMarker)),
			"the claim winner writes once and both clients observe the takeover output",
		);

		await disconnect(takeover);
		const vacant = await remainingObserver.status();
		check(vacant?.clientRole === "observer", "writer disconnect leaves observers attached with no hidden replacement writer");
		check(
			vacant.writerAttached === false && vacant.cols === takeoverCols && vacant.rows === takeoverRows,
			"writer disconnect preserves the last valid PTY dimensions",
		);

		const reconnect = new NativeSessionClient();
		const reconnectSink = makeSink(reconnect);
		await reconnect.connect(started.record, token);
		check(reconnect.getRole() === "observer", "reconnect while an observer remains does not acquire writer implicitly");
		const reconnectClaim = await reconnect.claimWriter();
		check(reconnectClaim.role === "writer", "the reconnect becomes writer only through an explicit claim");
		const reconnectMarker = `RECONNECT-${nonce}`;
		send(reconnect, outputCommand(reconnectMarker));
		check(
			(await reconnectSink.waitFor(reconnectMarker)) && (await sinks[losingIndex]!.waitFor(reconnectMarker)),
			"reconnected writer and standing observer both receive output",
		);

		await Promise.all([disconnect(reconnect), disconnect(remainingObserver)]);
		const sole = new NativeSessionClient();
		await sole.connect(started.record, token);
		check(sole.getRole() === "writer", "a later sole client preserves existing single-client writer behavior");
		await disconnect(sole);

		check(await stop(sessionId, { timeoutMs: 8000 }), "first host stops cleanly after the multi-client lifecycle");
		const restarted = await start(sessionId, { timeoutMs: 15_000 });
		restartedHostPid = restarted.record.host.pid;
		const afterRestart = new NativeSessionClient();
		await afterRestart.connect(restarted.record, readFileSync(tokenFile(sessionId), "utf8").trim());
		check(afterRestart.getRole() === "writer", "host restart carries no stale writer lease");
		await disconnect(afterRestart);

		const persisted = JSON.parse(readFileSync(recordFile(sessionId), "utf8")) as Record<string, unknown>;
		check(
			!("writer" in persisted) && !("clientRole" in persisted) && !("writerAttached" in persisted),
			"writer ownership remains ephemeral host state, absent from the session record",
		);
		check(readRecord(sessionId)?.host.pid === restartedHostPid, "restart publishes only the new host identity");
		check(!existsSync(sentinel), "the complete two-client lifecycle NEVER invokes tmux");
	} finally {
		try {
			await stop(sessionId, { timeoutMs: 8000 });
		} catch {
			// best-effort cleanup
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
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
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
