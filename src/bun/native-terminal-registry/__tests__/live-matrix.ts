#!/usr/bin/env bun
/**
 * Live-parser TUI matrix driver (seq 1228).
 *
 * Runs ONE real terminal program (shell or agent TUI) as a native-session with
 * the live parser + ground-truth tap enabled, drives a scripted timeline
 * (waits, input, resize) through the protocol v1 client, detaches, and then:
 *   1. reads the persisted bounded parser state (the reconstruction path);
 *   2. replays the ordered stream tap up to the snapshot watermark through a
 *      fresh Ghostty core (ground truth);
 *   3. emits a verdict: semantic-equality match, parser health, query replies,
 *      drain latency, and host memory — the practical budget numbers.
 *
 * PRIVACY (fail-closed, mirrors the terminal-state spike matrix): agent
 * targets never publish raw bytes or screen content — their verdict carries
 * only a SHA-256 of the raw stream plus structural metrics. Shell targets may
 * include the reconstructed screen text. Raw session state lives in the
 * session directory given by DEV3_NATIVE_SESSIONS_DIR and is removed with the
 * session; nothing raw is written into the output directory for agents.
 *
 *   bun live-matrix.ts <spec.json> <outdir>
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeSessionClient } from "../client";
import { GhosttyLiveParser, type NativeSemanticState } from "../ghostty-live";
import { readParserState, type ParserStateSnapshot } from "../parser-state";
import { readToken } from "../record";
import { start, status, stop } from "../registry";
import { readStreamTap } from "../stream-tap";

export type LiveMatrixStep =
	| { type: "wait"; ms: number }
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number };

export interface LiveMatrixSpec {
	target: string;
	kind: "shell" | "agent";
	/** The TUI under test IS the session command (no wrapper shell). */
	command: string[];
	/** Provenance label so absolute paths never leak into the verdict. */
	commandLabel?: string;
	cols: number;
	rows: number;
	script: LiveMatrixStep[];
	/** Best-effort clean-exit inputs sent after the detach proof. */
	exitInputs?: string[];
	exitGraceMs?: number;
}

export interface LiveMatrixVerdict {
	target: string;
	kind: "shell" | "agent";
	command: string;
	platform: string;
	bunVersion: string;
	parser: string;
	health: ParserStateSnapshot["health"] | null;
	ingested: ParserStateSnapshot["ingested"] | null;
	latency: ParserStateSnapshot["latency"] | null;
	memory: ParserStateSnapshot["memory"] | null;
	watermarkSeq: number | null;
	tapEvents: number;
	streamBytes: number;
	streamSha256: string;
	reconstructionMatch: boolean;
	mismatchHint?: string;
	/** Shell targets only — agents stay metrics-and-hash-only. */
	screenText?: string[];
	activeBuffer?: string;
	title?: string;
	finalDims?: { cols: number; rows: number };
	cleanExit: boolean;
	stopped: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function firstDifference(a: NativeSemanticState, b: NativeSemanticState): string {
	for (const key of Object.keys(a) as Array<keyof NativeSemanticState>) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return String(key);
	}
	return "unknown";
}

export async function runLiveMatrixTarget(spec: LiveMatrixSpec): Promise<LiveMatrixVerdict> {
	const sessionId = `lm-${spec.target.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	const result = await start(sessionId, {
		cmd: spec.command,
		cols: spec.cols,
		rows: spec.rows,
		liveParser: true,
		stateTap: true,
		timeoutMs: 30_000,
	});

	const client = new NativeSessionClient();
	await client.connect(result.record, readToken(sessionId) ?? "", { timeoutMs: 8000 });
	for (const step of spec.script) {
		if (step.type === "wait") await delay(step.ms);
		else if (step.type === "input") client.input(step.data);
		else client.resize(step.cols, step.rows);
	}
	// Detach boundary — the host flushes the reconstructable state.
	client.close();
	await delay(800);

	const snapshot = readParserState(sessionId);
	const tap = readStreamTap(sessionId);
	const hash = createHash("sha256");
	let streamBytes = 0;
	for (const entry of tap) {
		if (entry.kind !== "output") continue;
		const bytes = Buffer.from(entry.data, "base64");
		hash.update(bytes);
		streamBytes += bytes.length;
	}

	let reconstructionMatch = false;
	let mismatchHint: string | undefined;
	if (snapshot?.state && snapshot.health.status === "live") {
		const replay = await GhosttyLiveParser.create({ cols: spec.cols, rows: spec.rows, scrollbackLimit: 1000 });
		try {
			for (const entry of tap) {
				if (entry.seq > snapshot.watermarkSeq) break;
				if (entry.kind === "output") replay.ingest(new Uint8Array(Buffer.from(entry.data, "base64")));
				else replay.resize(entry.cols, entry.rows);
			}
			const truth = replay.inspect(200);
			reconstructionMatch = JSON.stringify(truth) === JSON.stringify(snapshot.state);
			if (!reconstructionMatch) mismatchHint = firstDifference(truth, snapshot.state);
		} finally {
			replay.dispose();
		}
	}

	// Best-effort clean exit through a fresh client, then an owned stop.
	let cleanExit = false;
	if (spec.exitInputs && spec.exitInputs.length > 0) {
		try {
			const closer = await NativeSessionClient.discover(sessionId, { timeoutMs: 5000 });
			for (const input of spec.exitInputs) {
				closer.input(input);
				await delay(400);
			}
			const deadline = Date.now() + (spec.exitGraceMs ?? 5000);
			while (Date.now() < deadline) {
				const live = await status(sessionId);
				if (!live.running) {
					cleanExit = true;
					break;
				}
				await delay(200);
			}
			closer.close();
		} catch {
			cleanExit = true; // host already gone — the TUI exited on its own
		}
	}
	const stopped = await stop(sessionId, { timeoutMs: 10_000 });

	const verdict: LiveMatrixVerdict = {
		target: spec.target,
		kind: spec.kind,
		command: spec.commandLabel ?? spec.command.join(" "),
		platform: process.platform,
		bunVersion: Bun.version,
		parser: snapshot?.parser ?? "unavailable",
		health: snapshot?.health ?? null,
		ingested: snapshot?.ingested ?? null,
		latency: snapshot?.latency ?? null,
		memory: snapshot?.memory ?? null,
		watermarkSeq: snapshot?.watermarkSeq ?? null,
		tapEvents: tap.length,
		streamBytes,
		streamSha256: hash.digest("hex"),
		reconstructionMatch,
		...(mismatchHint ? { mismatchHint } : {}),
		cleanExit,
		stopped,
	};
	if (spec.kind === "shell" && snapshot?.state) {
		verdict.screenText = snapshot.state.screen.map((line) => line.text);
		verdict.activeBuffer = snapshot.state.activeBuffer;
		verdict.title = snapshot.state.title;
		verdict.finalDims = snapshot.state.dimensions;
	}
	return verdict;
}

async function main(): Promise<void> {
	const specPath = process.argv[2];
	const outDir = process.argv[3];
	if (!specPath || !outDir) {
		process.stderr.write("usage: live-matrix.ts <spec.json> <outdir>\n");
		process.exit(2);
	}
	const spec = JSON.parse(await Bun.file(specPath).text()) as LiveMatrixSpec;
	if (!Array.isArray(spec.command) || spec.command.length === 0) {
		throw new Error("live-matrix spec requires a non-empty command array");
	}
	const verdict = await runLiveMatrixTarget(spec);
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `${spec.target}.verdict.json`);
	writeFileSync(outPath, `${JSON.stringify(verdict, null, 2)}\n`);
	console.log(
		`${spec.target}: match=${verdict.reconstructionMatch} health=${verdict.health?.status ?? "none"} ` +
			`replies=${verdict.ingested?.replies ?? 0} p95=${verdict.latency?.p95Ms ?? "?"}ms → ${outPath}`,
	);
	process.exit(verdict.reconstructionMatch ? 0 : 1);
}

if (import.meta.main) await main();
