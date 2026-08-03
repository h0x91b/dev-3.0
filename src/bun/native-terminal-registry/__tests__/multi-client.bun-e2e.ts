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
import { defineShellLaunchSpec, encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "../shell-launch";

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
	const launch = defineShellLaunchSpec({
		executable: isWindows ? "powershell.exe" : "/bin/bash",
		argv: isWindows ? ["-NoLogo", "-NoProfile", "-NoExit"] : ["--norc", "--noprofile"],
		cwd: root,
		env: {},
	});
	process.env[NATIVE_SESSION_LAUNCH_ENV] = encodeShellLaunchSpec(launch);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const nonce = `n${Date.now()}`;
	const sessionId = "multi-client";
	let restartedHostPid: number | null = null;

	try {
		const started = await start(sessionId, { launch, timeoutMs: 15_000 });
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
		const writerErrors = errorSinks[writerIndex]!;

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
		// The sender's cache follows the host's ACKNOWLEDGEMENT, never the value it merely
		// sent — an unowned resize is refused, and caching it optimistically would hand
		// every viewer a size the PTY never had. The host skips the sender in its geometry
		// broadcast, so the ack is the only thing that can refresh this; no status call is
		// made here, which is what proves it.
		const ackDeadline = Date.now() + 4000;
		while (Date.now() < ackDeadline) {
			const cached = writer.getPtyGeometry();
			if (cached?.cols === writerCols && cached.rows === writerRows) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		const senderCache = writer.getPtyGeometry();
		check(
			senderCache?.cols === writerCols && senderCache?.rows === writerRows,
			"the writer's cached grid follows the host's resize ACK, with no status round trip",
		);
		const resized = await writer.status();
		check(resized.cols === writerCols && resized.rows === writerRows, "the current writer controls the PTY dimensions");

		// A FRESH observer must know the canonical grid before the writer ever resizes:
		// `welcome` carries the role but no size, so without the attach-time status read
		// it would reflow the writer's byte stream at its own width.
		const fresh = new NativeSessionClient();
		makeSink(fresh);
		await fresh.connect(started.record, token);
		clients.push(fresh);
		check(fresh.getRole() === "observer", "a third attach is an observer, so it does not own the grid");
		const freshGeometry = fresh.getPtyGeometry();
		check(
			freshGeometry?.cols === writerCols && freshGeometry?.rows === writerRows,
			`a freshly attached observer already knows the writer's grid (${writerCols}x${writerRows}) with no resize involved`,
		);
		// An observer's own viewport must never move the shared PTY.
		fresh.resize(writerCols + 31, writerRows + 13);
		const afterObserverResize = await writer.status();
		check(
			afterObserverResize.cols === writerCols && afterObserverResize.rows === writerRows,
			"an observer's viewport never changes the canonical PTY size",
		);
		await disconnect(fresh);
		clients.pop();

		// ── explicit takeover of a LIVE writer ──
		// A plain claim is refused here by design; the explicit action is the only way a
		// lease moves while someone is typing. The ordering that matters is that the
		// displaced client is already an observer by the time the winner is confirmed —
		// otherwise there is a window in which both believe they own the one PTY.
		const preTakeoverErrors = observerErrors.all().length;
		const liveTakeover = await observer.takeoverWriter();
		check(
			liveTakeover.role === "writer" && liveTakeover.writerAttached,
			"an explicit takeover moves the lease while the previous writer is still attached",
		);
		// Frame arrival order across two sockets is NOT guaranteed, so asserting the
		// displaced client's own cached role at this instant would be a scheduling bet.
		// Ask the HOST instead: it decides, and its answer per connection is authoritative
		// the moment the swap happened. That is also the property that actually matters —
		// enforcement is host-side, not in either client's belief about itself.
		const winnerView = await observer.status();
		const loserView = await writer.status();
		check(
			winnerView.clientRole === "writer" && loserView.clientRole === "observer" && loserView.writerAttached === true,
			"the HOST reports exactly one writer immediately after the swap — the displaced connection is an observer to it",
		);
		check(observerErrors.all().length === preTakeoverErrors, "the takeover produced no error frame");
		const displacedRejected = `DISPLACED-${nonce}`;
		const beforeDisplacedErr = writerErrors.all().length;
		send(writer, outputCommand(displacedRejected));
		const displacedConflict = await writerErrors.waitFor("conflict", beforeDisplacedErr);
		check(displacedConflict !== null, "the displaced client's input is refused by the host in turn");
		// Over the real wire: a client whose cached role is STALE still gestures. The
		// displaced client here believes it is the writer until it processes its demotion,
		// so its explicit takeover must be SENT and must win — last explicit wins.
		const staleGeneration = writer.getWriterGeneration();
		// NO status call before the stale resize: a status round trip is a same-socket
		// barrier behind the demotion frame AND refreshes the generation, which would make
		// the request perfectly current. The grid and cache come from what the displaced
		// client already knows, so the resize goes out on its OLD generation.
		const gridBeforeStaleResize = writer.getPtyGeometry();
		const staleErrBefore = writerErrors.all().length;
		const staleResize = writer.resizeAwaited(writerCols + 40, 20).catch((err) => err as Error);
		const staleResizeRefused = await writerErrors.waitFor("conflict", staleErrBefore);
		const staleOutcome = await staleResize;
		check(
			staleResizeRefused !== null && staleResizeRefused.code === "conflict",
			`a stale writer's resize is refused with a conflict (reason: ${staleResizeRefused?.message ?? "none"})`,
		);
		// A stale writer that takes over becomes the writer again, so `canMutatePty` passes,
		// while its cached generation is still the pre-takeover one because the takeover
		// reply has not been processed yet. Sending both without awaiting the first is what
		// reaches the host's generation validation.
		const genErrBefore = writerErrors.all().length;
		const generationBeforeRetake = writer.getWriterGeneration();
		const retake = writer.takeoverWriter();
		const resizeOnStaleGeneration = writer.resizeAwaited(writerCols + 11, writerRows + 7).catch((e) => e as Error);
		await retake;
		const generationRefusal = await writerErrors.waitFor("conflict", genErrBefore);
		const staleGenOutcome = await resizeOnStaleGeneration;
		check(
			generationRefusal !== null && generationRefusal.message?.includes("generation") === true,
			`the host rejects a resize carrying a STALE generation, by that exact reason (got ${generationRefusal?.message ?? "none"})`,
		);
		check(
			staleGenOutcome instanceof Error && writer.getWriterGeneration() !== generationBeforeRetake,
			"the stale-generation resize settles as a failure while the lease itself moved on",
		);
		const afterGenerationRefusal = await observer.status();
		check(
			afterGenerationRefusal.cols === writerCols && afterGenerationRefusal.rows === writerRows,
			"a generation-rejected resize leaves the canonical PTY size untouched",
		);
		check(
			staleOutcome instanceof Error && /conflict/.test(staleOutcome.message),
			"the refusal settles the SENDER'S OWN correlated request rather than leaking to another",
		);
		check(
			writer.getPtyGeometry()?.cols === gridBeforeStaleResize?.cols
				&& writer.getPtyGeometry()?.rows === gridBeforeStaleResize?.rows,
			"a refused resize does NOT poison the sender's cached canonical grid",
		);
		// Only NOW is a status call safe: the canonical size must be unchanged host-side too.
		const afterStaleResize = await observer.status();
		check(
			afterStaleResize.cols === writerCols && afterStaleResize.rows === writerRows,
			`the canonical PTY size is untouched by the refused resize (${writerCols}x${writerRows})`,
		);

		// Hand it back so the release/claim assertions below keep their original subject.
		const handedBack = await writer.takeoverWriter();
		check(
			typeof staleGeneration === "number" && handedBack.writerGeneration === staleGeneration + 1,
			"the explicit gesture from a client with a STALE cached role still wins, and bumps the generation",
		);
		check(
			handedBack.role === "writer" && observer.getRole() === "observer",
			"a takeover works in both directions — the transfer is not one-way",
		);

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
		const restarted = await start(sessionId, { launch, timeoutMs: 15_000 });
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
