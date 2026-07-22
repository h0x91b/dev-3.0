#!/usr/bin/env bun
/**
 * Live-parser lifecycle E2E (seq 1228) on the REAL Bun runtime (vitest stubs
 * the Bun global, so a live Bun.Terminal cannot run there).
 * Run: `bun run test:native-live-parser-e2e`.
 *
 * Proves, against a real detached host + shell on this platform:
 *   • the host maintains a live Ghostty screen while Bun.Terminal streams
 *     output — parsing deferred to the event loop, never inside the callback;
 *   • a parser-generated DSR reply reaches the SHELL's stdin exactly once
 *     (write-back to the same PTY, no loops, no duplicate replies);
 *   • title, colors, Unicode, resize ordering, and alternate screen are
 *     tracked live and survive into the persisted parser state;
 *   • after detach, a fresh process reconstructs the SAME semantic screen from
 *     the bounded parser-state path, byte-equal to a ground-truth replay of the
 *     ordered stream tap up to the snapshot watermark;
 *   • queue overflow is bounded and reported explicitly — host, shell, raw
 *     output, journal cap, and protocol v1 all stay healthy;
 *   • an injected parser fault is contained: the session keeps serving raw
 *     bytes, other sessions are untouched, nothing crashes;
 *   • tmux is never invoked (PATH-shim sentinel stays absent).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "../../spawn";
import { NativeSessionClient } from "../client";
import { GhosttyLiveParser, type NativeSemanticState } from "../ghostty-live";
import { journalFile, tokenFile } from "../paths";
import { readParserState, type ParserStateSnapshot } from "../parser-state";
import { isProcessAlive } from "../process-identity";
import { readRecord } from "../record";
import { start, stop } from "../registry";
import { readStreamTap } from "../stream-tap";

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
		async waitFor(sub, timeoutMs = 8000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (buf.includes(sub)) return true;
				await delay(30);
			}
			return false;
		},
		async waitForMatch(re, timeoutMs = 8000) {
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

async function pollParserState(
	sessionId: string,
	predicate: (snapshot: ParserStateSnapshot) => boolean,
	timeoutMs = 5000,
): Promise<ParserStateSnapshot | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const snapshot = readParserState(sessionId);
		if (snapshot && predicate(snapshot)) return snapshot;
		await delay(100);
	}
	return null;
}

/**
 * The probes run INSIDE the session shell (`bun <file>`), so their output and
 * stdin are the host's PTY. Written as files to avoid shell-quoting drift
 * between bash and PowerShell.
 */
function writeProbeScripts(dir: string): { dsrPaint: string; altScreen: string; flood: string } {
	const dsrPaint = join(dir, "dsr-paint.ts");
	writeFileSync(
		dsrPaint,
		[
			`process.stdout.write("\\x1b]0;LP-E2E-TITLE\\x07");`,
			`console.log("\\x1b[35mMAGENTA\\x1b[0m plain \\u{1F680} \\u0416");`,
			`let buf = "";`,
			`let armed = false;`,
			`const finish = (count: number): void => { console.log("DSR-COUNT:" + count + ":END"); process.exit(0); };`,
			`const bail = setTimeout(() => finish((buf.match(/\\x1b\\[\\d+;\\d+R/g) ?? []).length), 4000);`,
			`process.stdin.setRawMode?.(true);`,
			`process.stdin.resume();`,
			`process.stdin.on("data", (d: Buffer) => {`,
			`  buf += d.toString("latin1");`,
			`  if (armed || !/\\x1b\\[\\d+;\\d+R/.test(buf)) return;`,
			`  armed = true;`,
			`  // settle window: a duplicate reply would land here and be counted`,
			`  setTimeout(() => { clearTimeout(bail); finish((buf.match(/\\x1b\\[\\d+;\\d+R/g) ?? []).length); }, 700);`,
			`});`,
			`process.stdout.write("\\x1b[6n");`,
		].join("\n"),
	);

	const altScreen = join(dir, "alt-screen.ts");
	writeFileSync(
		altScreen,
		[
			`process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[HALT-SCREEN-CONTENT");`,
			`await Bun.sleep(2500);`,
			`process.stdout.write("\\x1b[?1049l");`,
			`console.log("ALT-DONE");`,
		].join("\n"),
	);

	const flood = join(dir, "flood.ts");
	writeFileSync(
		flood,
		[
			`for (let i = 0; i < 20000; i++) console.log("F".repeat(100));`,
			`console.log("FLOOD-DONE");`,
		].join("\n"),
	);

	return { dsrPaint, altScreen, flood };
}

/** Ground truth: replay the ordered tap up to `watermarkSeq` through a fresh core. */
async function replayGroundTruth(sessionId: string, watermarkSeq: number): Promise<NativeSemanticState> {
	const replay = await GhosttyLiveParser.create({ cols: 80, rows: 24, scrollbackLimit: 1000 });
	try {
		for (const entry of readStreamTap(sessionId)) {
			if (entry.seq > watermarkSeq) break;
			if (entry.kind === "output") replay.ingest(new Uint8Array(Buffer.from(entry.data, "base64")));
			else replay.resize(entry.cols, entry.rows);
		}
		return replay.inspect(200);
	} finally {
		replay.dispose();
	}
}

function screenText(state: NativeSemanticState | null | undefined): string {
	return (state?.screen ?? [])
		.concat(state?.scrollback ?? [])
		.map((line) => line.text)
		.join("\n");
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-live-parser-e2e-"));
	const metaDir = join(root, "meta");
	const shimDir = join(root, "shim");
	const probeDir = join(root, "probes");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	mkdirSync(probeDir, { recursive: true });
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

	const probes = writeProbeScripts(probeDir);
	// A pre-existing unrelated process the live parser must never disturb.
	const guard = spawn(
		isWindows
			? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 300"]
			: ["sleep", "300"],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const send = (client: NativeSessionClient, command: string): void => client.input(`${command}${lineEnd}`);

	try {
		// ── 1. live session: parsing runs while ConPTY/PTY output streams ──
		const main = await start("lp-main", { liveParser: true, stateTap: true, timeoutMs: 20_000 });
		check(main.status === "started", "lp-main started with the live parser enabled");
		check(isProcessAlive(main.record.host.pid), "lp-main host is alive");

		const c1 = new NativeSessionClient();
		await c1.connect(main.record, readFileSync(tokenFile("lp-main"), "utf8").trim());
		const s1 = makeSink(c1);

		send(c1, `bun "${probes.dsrPaint}"`);
		const dsr = await s1.waitForMatch(/DSR-COUNT:(\d+):END/, 15_000);
		check(dsr !== null, "DSR probe inside the shell completed");
		check(dsr?.[1] === "1", `parser answered the cursor-position query EXACTLY once (got ${dsr?.[1] ?? "none"})`);

		const liveDuringOutput = await pollParserState("lp-main", (s) => s.health.status === "live" && s.ingested.frames > 0);
		check(liveDuringOutput !== null, "parser state stays live while output streams");
		check((liveDuringOutput?.ingested.replies ?? 0) >= 1, "parser reply write-back is accounted in the snapshot");

		c1.resize(100, 30);
		const resized = await pollParserState("lp-main", (s) => s.state?.dimensions.cols === 100 && s.state?.dimensions.rows === 30);
		check(resized !== null, "live parser observed the protocol resize in order (100x30)");

		// Alternate screen tracked live (debounced snapshots refresh mid-run).
		send(c1, `bun "${probes.altScreen}"`);
		const altLive = await pollParserState(
			"lp-main",
			(s) => s.state?.activeBuffer === "alternate" && screenText(s.state).includes("ALT-SCREEN-CONTENT"),
			6000,
		);
		check(altLive !== null, "alternate screen + its content tracked live");
		check(await s1.waitFor("ALT-DONE", 10_000), "alt-screen probe exited");
		const altRestored = await pollParserState("lp-main", (s) => s.state?.activeBuffer === "normal", 6000);
		check(altRestored !== null, "primary buffer restored after leaving the alternate screen");

		// ── 2. detach → fresh-process semantic reconstruction ──
		await delay(600); // quiet period so the shell prompt settles
		c1.close();
		await delay(700); // host flushes parser state on detach; tap debounce lands

		const snapshot = readParserState("lp-main");
		check(snapshot !== null, "fresh process reads the persisted parser state after detach");
		check(snapshot?.health.status === "live", "parser health is live at the detach boundary");
		check(snapshot?.state?.title === "LP-E2E-TITLE", "title survived into the reconstructed state");
		check(snapshot?.state?.dimensions.cols === 100 && snapshot?.state?.dimensions.rows === 30, "dimensions survived");
		const text = screenText(snapshot?.state);
		check(text.includes("MAGENTA") && text.includes("plain"), "painted text is in the reconstructed screen");
		check(text.includes("\u{1F680}") && text.includes("Ж"), "Unicode (emoji + cyrillic) survived");
		const paintedLine = (snapshot?.state?.screen ?? []).concat(snapshot?.state?.scrollback ?? []).find((line) => line.text.includes("MAGENTA plain"));
		const magentaCell = paintedLine?.cells[paintedLine.text.indexOf("MAGENTA")];
		const plainCell = paintedLine?.cells[paintedLine.text.indexOf("plain")];
		check(
			Boolean(magentaCell && plainCell && magentaCell.foreground !== plainCell.foreground),
			"ANSI color survived (MAGENTA cell differs from plain cell)",
		);

		const tap = readStreamTap("lp-main");
		check(tap.length > 0, "ground-truth stream tap captured ordered events");
		check(
			snapshot !== null && tap.length > 0 && tap[tap.length - 1].seq === snapshot.watermarkSeq,
			"snapshot watermark covers every tapped event (nothing left unparsed at detach)",
		);
		const truth = snapshot ? await replayGroundTruth("lp-main", snapshot.watermarkSeq) : null;
		check(
			truth !== null && JSON.stringify(truth) === JSON.stringify(snapshot?.state),
			"reconstructed semantic screen EQUALS the ground-truth replay of the raw stream",
		);

		// Raw path + protocol v1 unaffected by the parser stage.
		const c2 = await NativeSessionClient.discover("lp-main");
		const s2 = makeSink(c2);
		const st = await c2.status();
		check(st.sessionId === "lp-main" && st.cols === 100 && st.rows === 30, "protocol v1 status works on a live-parser session");
		send(c2, isWindows ? 'Write-Output "REATTACH-MARK"' : 'echo "REATTACH-MARK"');
		check(await s2.waitFor("REATTACH-MARK"), "reattached client still receives raw PTY output");
		c2.close();

		// ── 3. overflow: bounded + explicit, session stays healthy ──
		process.env.DEV3_NATIVE_SESSION_PARSER_QUEUE_MAX_BYTES = "1024";
		const overflow = await start("lp-overflow", { liveParser: true, timeoutMs: 20_000 });
		delete process.env.DEV3_NATIVE_SESSION_PARSER_QUEUE_MAX_BYTES;
		const cOf = new NativeSessionClient();
		await cOf.connect(overflow.record, readFileSync(tokenFile("lp-overflow"), "utf8").trim());
		const sOf = makeSink(cOf);
		send(cOf, `bun "${probes.flood}"`);
		check(await sOf.waitFor("FLOOD-DONE", 30_000), "flood completed; raw output kept flowing to the client");
		const overflowState = await pollParserState("lp-overflow", (s) => s.health.status === "overflowed", 8000);
		check(overflowState !== null, "sustained output over the queue cap reports an EXPLICIT overflow verdict");
		check((overflowState?.health.overflow.droppedBytes ?? 0) > 0, "overflow accounting records dropped bytes");
		check(isProcessAlive(overflow.record.host.pid) && isProcessAlive(overflow.record.shell.pid), "host + shell survive the overflow");
		const stOf = await cOf.status();
		check(stOf.alive, "protocol v1 status still works after overflow");
		// The journal flush is debounced and starves while the flood saturates the
		// host's event loop — poll for the post-flood flush instead of a raw stat.
		const journalBytes = await (async (): Promise<number> => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				try {
					return statSync(journalFile("lp-overflow")).size;
				} catch {
					await delay(100);
				}
			}
			return -1;
		})();
		check(journalBytes > 0 && journalBytes <= 400 * 1024, `journal stays bounded under flood (${journalBytes} bytes)`);
		cOf.close();
		check(await stop("lp-overflow", { timeoutMs: 8000 }), "overflowed session stops cleanly");

		// ── 4. parser fault injection: contained, nothing else dies ──
		process.env.DEV3_NATIVE_SESSION_PARSER_FAULT = "ingest";
		const fault = await start("lp-fault", { liveParser: true, timeoutMs: 20_000 });
		delete process.env.DEV3_NATIVE_SESSION_PARSER_FAULT;
		const cF = new NativeSessionClient();
		await cF.connect(fault.record, readFileSync(tokenFile("lp-fault"), "utf8").trim());
		const sF = makeSink(cF);
		send(cF, isWindows ? 'Write-Output "FAULT-MARK"' : 'echo "FAULT-MARK"');
		check(await sF.waitFor("FAULT-MARK"), "raw PTY path keeps working while the parser fails");
		const faultState = await pollParserState("lp-fault", (s) => s.health.status === "failed", 8000);
		check(faultState !== null, "parser failure is recorded as a contained failed verdict");
		check((faultState?.health.error ?? "").includes("injected parser fault"), "failure verdict carries the parser error");
		check(isProcessAlive(fault.record.host.pid) && isProcessAlive(fault.record.shell.pid), "host + shell survive the parser failure");
		check(isProcessAlive(main.record.host.pid), "unrelated live-parser session (lp-main) is untouched by the failure");
		cF.close();
		check(await stop("lp-fault", { timeoutMs: 8000 }), "failed-parser session stops cleanly");

		// ── 5. isolation sentinels ──
		check(readRecord("lp-main") !== null, "lp-main record intact through sibling failures");
		check(isProcessAlive(guard.pid), "unrelated guard process untouched");
		check(!existsSync(sentinel), "tmux was NEVER invoked (PATH shim sentinel absent)");
	} finally {
		for (const id of ["lp-main", "lp-overflow", "lp-fault"]) {
			try {
				await stop(id, { timeoutMs: 6000 });
			} catch {
				// best-effort
			}
		}
		try {
			guard.kill();
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
		for (const id of ["lp-main", "lp-overflow", "lp-fault"]) {
			try {
				await stop(id, { timeoutMs: 3000 });
			} catch {
				// best-effort cleanup
			}
		}
		process.exit(1);
	});
