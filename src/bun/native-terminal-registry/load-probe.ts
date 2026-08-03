#!/usr/bin/env bun
/**
 * Real-PTY load/budget probe for the native parser pipeline (seq 1284).
 *
 * The deterministic harness (`native-terminal-load-budget/`) proves the policy
 * with a fake WASM core and a fake clock. This probe proves the same budgets
 * against REAL shells, a real Ghostty core, real atomic snapshot writes, and a
 * real event loop — the evidence the Windows validation gate asks for.
 *
 *   bun src/bun/native-terminal-registry/load-probe.ts [streams] [timeoutSeconds] [--legacy]
 *
 * `--legacy` reproduces the pre-seq-1284 policy (debounce only, no cadence
 * ceiling, no identical-skip) so a run pair yields honest before/after numbers.
 * `DEV3_LOAD_PROBE_LINES` / `_REDRAWS` / `_TAIL_SECONDS` size the workload — a
 * host whose shell is slow needs a bigger burst to reach the cadence ceiling.
 *
 * Each stream spawns one shell that emits a bounded, deterministic burst, feeds
 * it through a real LiveParserPipeline, and persists snapshots into a probe-only
 * temp directory (never `~/.dev3.0`). Prints one JSON verdict; exit code 1 when
 * any stream ends non-live, overflowed, or leaves state behind after cleanup.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../spawn";
import { LiveParserPipeline } from "./live-parser";
import type { ParserStateSnapshot } from "./parser-state";

const COLS = 120;
const ROWS = 40;
const FINAL_MARKER = "LOAD-PROBE-FINAL";
/** The steady-state line the redraw and tail phases keep reprinting over a CR. */
const STEADY_LINE = "status: steady";

function envInt(name: string, fallback: number): number {
	const parsed = Number(process.env[name]);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Workload size — env-tunable so a slow host can still reach the cadence ceiling. */
function workloadShape(): { lines: number; redraws: number; tailSeconds: number } {
	return {
		lines: envInt("DEV3_LOAD_PROBE_LINES", 1_200),
		redraws: envInt("DEV3_LOAD_PROBE_REDRAWS", 1_500),
		tailSeconds: envInt("DEV3_LOAD_PROBE_TAIL_SECONDS", 6),
	};
}

/**
 * Deterministic workload in the platform's real production shell: a scrolling
 * burst, a redraw phase whose screen stops changing, the final marker, then a
 * tail that reprints the SAME line once per second. The tail is what exercises
 * the identical-skip across several cadence windows — it must emit real bytes,
 * so it reprints a full line rather than a bare carriage return (a lone CR
 * produced no observable output on Windows ConPTY, hiding the skip path).
 */
function workloadCommand(): string[] {
	const { lines, redraws, tailSeconds } = workloadShape();
	if (process.platform === "win32") {
		const body =
			`for($i=0;$i -lt ${lines};$i++){Write-Host ("line-$i-" + ("x" * 70))};` +
			`for($j=0;$j -lt ${redraws};$j++){Write-Host -NoNewline ("\`r" + "${STEADY_LINE}")};` +
			`Write-Host "";Write-Host "${FINAL_MARKER}";` +
			`for($k=0;$k -lt ${tailSeconds};$k++){Start-Sleep -Seconds 1;Write-Host -NoNewline ("\`r" + "${STEADY_LINE}")}`;
		return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", body];
	}
	const sh =
		`i=0; while [ $i -lt ${lines} ]; do echo "line-$i-$(printf 'x%.0s' $(seq 70))"; i=$((i+1)); done; ` +
		`j=0; while [ $j -lt ${redraws} ]; do printf '\\r${STEADY_LINE}'; j=$((j+1)); done; ` +
		`echo; echo ${FINAL_MARKER}; ` +
		`k=0; while [ $k -lt ${tailSeconds} ]; do sleep 1; printf '\\r${STEADY_LINE}'; k=$((k+1)); done`;
	return ["/bin/sh", "-c", sh];
}

export interface StreamVerdict {
	streamId: string;
	callbacks: number;
	callbackBytes: number;
	frames: number;
	drains: number;
	watermarkSeq: number;
	queueHighWaterBytes: number;
	queueHighWaterEvents: number;
	queueMaxBytes: number;
	queuePressure: string;
	slowConsumerEpisodes: number;
	snapshotWrites: number;
	snapshotSkipped: number;
	snapshotCoalesced: number;
	snapshotFailures: number;
	snapshotLastBytes: number;
	snapshotMaxBytes: number;
	snapshotTotalBytes: number;
	resyncGaps: number;
	health: string;
	screenPlausible: boolean;
	writesPerSecond: number;
}

export interface LoadProbeVerdict {
	platform: string;
	bunVersion: string;
	streams: number;
	/** True when the pre-seq-1284 persistence policy was emulated. */
	legacy: boolean;
	elapsedMs: number;
	rssBeforeBytes: number;
	rssAfterBytes: number;
	rssPeakBytes: number;
	perStream: StreamVerdict[];
	cleanup: { childrenExited: number; stateDirRemoved: boolean };
	ok: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Same tmp+rename discipline as the host, but confined to the probe's own dir. */
function writeProbeState(dir: string, streamId: string, snapshot: ParserStateSnapshot): void {
	const target = join(dir, `${streamId}.json`);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
	renameSync(tmp, target);
}

async function runStream(streamId: string, stateDir: string, timeoutMs: number, legacy: boolean): Promise<StreamVerdict> {
	const started = Date.now();
	let callbacks = 0;
	let callbackBytes = 0;
	let terminalRef: { write(data: string | Uint8Array): void } | null = null;
	const pipeline = await LiveParserPipeline.create({
		sessionId: streamId,
		cols: COLS,
		rows: ROWS,
		writeReply: (reply) => {
			try {
				terminalRef?.write(reply);
			} catch {
				// child already exited — the reply is moot
			}
		},
		persistState: (snapshot) => writeProbeState(stateDir, streamId, snapshot),
		...(legacy ? { persistMinIntervalMs: 0, persistSkipIdentical: false } : {}),
	});
	const child = spawn(workloadCommand(), {
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols: COLS,
			rows: ROWS,
			data(_terminal: unknown, chunk: Uint8Array) {
				callbacks++;
				callbackBytes += chunk.length;
				pipeline.onOutput(chunk); // bounded enqueue ONLY — the seq 1228 boundary
			},
		},
	});
	terminalRef = child.terminal ?? null;
	await Promise.race([child.exited, delay(timeoutMs)]);
	if (child.exitCode === null) child.kill();
	await child.exited;
	await delay(250); // let trailing callbacks and the debounce land
	await pipeline.flushAndWait();
	const snapshot = pipeline.snapshot();
	const queue = pipeline.queueCounters();
	const persistence = pipeline.persistenceCounters();
	const lines = [...(snapshot.state?.screen ?? []), ...(snapshot.state?.scrollback ?? [])];
	const elapsedSec = Math.max(0.001, (Date.now() - started) / 1000);
	await pipeline.disposeAndWait();
	return {
		streamId,
		callbacks,
		callbackBytes,
		frames: snapshot.ingested.frames,
		drains: snapshot.latency.drains,
		watermarkSeq: snapshot.watermarkSeq,
		queueHighWaterBytes: queue.highWaterBytes,
		queueHighWaterEvents: queue.highWaterEvents,
		queueMaxBytes: queue.maxBytes,
		queuePressure: queue.pressure,
		slowConsumerEpisodes: queue.slowConsumerEpisodes,
		snapshotWrites: persistence.writes,
		snapshotSkipped: persistence.skippedIdentical,
		snapshotCoalesced: persistence.coalesced,
		snapshotFailures: persistence.failures,
		snapshotLastBytes: persistence.lastBytes,
		snapshotMaxBytes: persistence.maxBytes,
		snapshotTotalBytes: persistence.totalBytes,
		resyncGaps: pipeline.resyncCounters().gaps,
		health: snapshot.health.status,
		screenPlausible: lines.some((line) => line.text.includes(FINAL_MARKER)),
		writesPerSecond: Number((persistence.writes / elapsedSec).toFixed(3)),
	};
}

export async function runLoadProbe(streams: number, timeoutMs: number, legacy = false): Promise<LoadProbeVerdict> {
	const startedAt = Date.now();
	const stateDir = mkdtempSync(join(tmpdir(), "dev3-native-load-probe-"));
	const rssBefore = process.memoryUsage().rss;
	let rssPeak = rssBefore;
	const sampler = setInterval(() => {
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	}, 100);
	sampler.unref?.();
	let perStream: StreamVerdict[] = [];
	try {
		perStream = await Promise.all(
			Array.from({ length: streams }, (_, index) => runStream(`probe-${index}`, stateDir, timeoutMs, legacy)),
		);
	} finally {
		clearInterval(sampler);
	}
	let stateDirRemoved = true;
	try {
		rmSync(stateDir, { recursive: true, force: true });
	} catch {
		stateDirRemoved = false;
	}
	const rssAfter = process.memoryUsage().rss;
	return {
		platform: process.platform,
		bunVersion: Bun.version,
		streams,
		legacy,
		elapsedMs: Date.now() - startedAt,
		rssBeforeBytes: rssBefore,
		rssAfterBytes: rssAfter,
		rssPeakBytes: Math.max(rssPeak, rssAfter),
		perStream,
		cleanup: { childrenExited: perStream.length, stateDirRemoved },
		ok:
			stateDirRemoved &&
			perStream.every(
				(s) => s.health === "live" && s.queuePressure !== "overflowed" && s.snapshotFailures === 0 && s.screenPlausible,
			),
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2).filter((a) => a !== "--legacy");
	const legacy = process.argv.includes("--legacy");
	const streams = Number(args[0] ?? 6);
	const timeoutSeconds = Number(args[1] ?? 60);
	if (!Number.isInteger(streams) || streams < 1 || streams > 64) {
		process.stderr.write("usage: load-probe.ts [streams 1-64] [timeoutSeconds] [--legacy]\n");
		process.exit(2);
	}
	const verdict = await runLoadProbe(streams, timeoutSeconds * 1000, legacy);
	process.stdout.write(`${JSON.stringify(verdict)}\n`);
	process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) await main();
