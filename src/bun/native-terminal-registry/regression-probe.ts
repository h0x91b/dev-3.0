#!/usr/bin/env bun
/**
 * Seq 1185 regression probe: Ghostty WASM inside vs outside the Bun.Terminal
 * data callback.
 *
 * `callback` mode reproduces the exact failing shape from the terminal-state
 * spike (decision 146): a Ghostty core created up front, with `ingest()` +
 * `readResponses()` invoked DIRECTLY inside the Bun.Terminal data callback.
 * On native Windows Bun 1.3.14 that path returned a negative WASM allocation
 * pointer during live ingestion; this probe preserves the reproduction as
 * runnable evidence instead of a prose claim.
 *
 * `deferred` mode runs the same workload through the LiveParserPipeline (the
 * seq 1228 fix): the callback only enqueues, parsing happens on a later
 * event-loop task. This mode must stay clean on every supported platform.
 *
 *   bun src/bun/native-terminal-registry/regression-probe.ts [callback|deferred|both]
 *
 * Prints one JSON verdict per mode. Exit code is 1 only when the DEFERRED mode
 * fails — the callback verdict is evidence, not a gate (it is EXPECTED to fail
 * on Windows Bun 1.3.14 until the upstream bug is fixed).
 */

import { spawn } from "../spawn";
import { GhosttyLiveParser } from "./ghostty-live";
import { LiveParserPipeline } from "./live-parser";

const PROBE_LINES = 2000;
const FINAL_MARKER = "PROBE-FINAL-MARKER";

/** Deterministic workload: colored burst + a DSR query + a final marker line. */
function childCommand(): string[] {
	const script =
		`process.stdout.write("\\x1b]0;probe-title\\x07");` +
		`for (let i = 0; i < ${PROBE_LINES}; i++) console.log("\\x1b[3" + (i % 8) + "mline-" + i + "-" + "x".repeat(70) + "\\x1b[0m");` +
		`process.stdout.write("\\x1b[6n");` +
		`console.log("${FINAL_MARKER}");`;
	return [process.execPath, "-e", script];
}

export interface ProbeVerdict {
	mode: "callback" | "deferred";
	platform: string;
	bunVersion: string;
	callbacks: number;
	bytes: number;
	replies: number;
	failed: boolean;
	error?: string;
	/** Parsed screen contains the final marker — parsing stayed coherent. */
	screenPlausible: boolean;
	elapsedMs: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runCallbackMode(): Promise<ProbeVerdict> {
	const started = Date.now();
	// Created OUTSIDE the callback — creation was never the failing step.
	const parser = await GhosttyLiveParser.create({ cols: 100, rows: 30, scrollbackLimit: 1000 });
	let callbacks = 0;
	let bytes = 0;
	let replies = 0;
	let error: string | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	child = spawn(childCommand(), {
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols: 100,
			rows: 30,
			data(_terminal: unknown, chunk: Uint8Array) {
				callbacks++;
				bytes += chunk.length;
				if (error) return;
				try {
					// The seq 1185 failing shape: Ghostty WASM inside the data callback.
					parser.ingest(chunk);
					for (const response of parser.readResponses()) {
						replies++;
						child?.terminal?.write(response);
					}
				} catch (err) {
					error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
				}
			},
		},
	});
	await Promise.race([child.exited, delay(30_000)]);
	if (child.exitCode === null) child.kill();
	await child.exited;
	await delay(200); // let trailing callbacks land
	let screenPlausible = false;
	if (!error) {
		try {
			const state = parser.inspect(1000);
			screenPlausible = [...state.screen, ...state.scrollback].some((line) => line.text.includes(FINAL_MARKER));
		} catch (err) {
			error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		}
	}
	try {
		parser.dispose();
	} catch {
		// a corrupted core may fail to free — the verdict already records the error
	}
	return {
		mode: "callback",
		platform: process.platform,
		bunVersion: Bun.version,
		callbacks,
		bytes,
		replies,
		failed: Boolean(error),
		...(error ? { error } : {}),
		screenPlausible,
		elapsedMs: Date.now() - started,
	};
}

async function runDeferredMode(): Promise<ProbeVerdict> {
	const started = Date.now();
	let callbacks = 0;
	let bytes = 0;
	let terminalRef: { write(data: string | Uint8Array): void } | null = null;
	const pipeline = await LiveParserPipeline.create({
		sessionId: "regression-probe",
		cols: 100,
		rows: 30,
		writeReply: (reply) => {
			try {
				terminalRef?.write(reply);
			} catch {
				// child already exited
			}
		},
		persistState: () => {}, // verdict is read from the in-memory snapshot
	});
	const child = spawn(childCommand(), {
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols: 100,
			rows: 30,
			data(_terminal: unknown, chunk: Uint8Array) {
				callbacks++;
				bytes += chunk.length;
				pipeline.onOutput(chunk); // bounded enqueue ONLY — the seq 1228 boundary
			},
		},
	});
	terminalRef = child.terminal ?? null;
	await Promise.race([child.exited, delay(30_000)]);
	if (child.exitCode === null) child.kill();
	await child.exited;
	await delay(200);
	pipeline.flush();
	const snapshot = pipeline.snapshot();
	const lines = [...(snapshot.state?.screen ?? []), ...(snapshot.state?.scrollback ?? [])];
	const verdict: ProbeVerdict = {
		mode: "deferred",
		platform: process.platform,
		bunVersion: Bun.version,
		callbacks,
		bytes,
		replies: snapshot.ingested.replies,
		failed: snapshot.health.status !== "live",
		...(snapshot.health.error ? { error: snapshot.health.error } : {}),
		screenPlausible: lines.some((line) => line.text.includes(FINAL_MARKER)),
		elapsedMs: Date.now() - started,
	};
	pipeline.dispose();
	return verdict;
}

async function main(): Promise<void> {
	const mode = process.argv[2] ?? "both";
	const verdicts: ProbeVerdict[] = [];
	if (mode === "callback" || mode === "both") verdicts.push(await runCallbackMode());
	if (mode === "deferred" || mode === "both") verdicts.push(await runDeferredMode());
	if (verdicts.length === 0) {
		process.stderr.write("usage: regression-probe.ts [callback|deferred|both]\n");
		process.exit(2);
	}
	for (const verdict of verdicts) process.stdout.write(`${JSON.stringify(verdict)}\n`);
	const deferred = verdicts.find((v) => v.mode === "deferred");
	if (deferred && (deferred.failed || !deferred.screenPlausible)) process.exit(1);
	process.exit(0);
}

if (import.meta.main) await main();
