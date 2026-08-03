#!/usr/bin/env bun
/**
 * Incremental cost of each capture mode, measured on real panes.
 *
 * Every configuration runs in all four modes with identical panes and identical
 * shell load, and only the delta against `none` is reported: an absolute figure
 * measures the machine, not the feature.
 *
 * Method, because the numbers are worth exactly what the method is:
 *  - Every pane is resized to the stated geometry and VERIFIED from its record
 *    before the window opens; a mixed grid aborts the run instead of reporting.
 *  - Flood writes are awaited and counted, and the ACHIEVED lines/s per pane is
 *    reported, so an arm cannot look cheap by having done less work.
 *  - Published bytes come from write EVENTS on the artifact, not from polled size
 *    sums that miss or double-count writes.
 *  - Memory is phys_footprint, which counts shared pages once. Summed RSS is
 *    reported beside it and labelled as the overstating bound it is.
 *  - Arm order rotates per round so machine drift cannot bias one arm, and
 *    min/p50/p95 plus every raw round are printed.
 */

import { mkdtempSync, rmSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCoordinatorDeps, type CoordinatorDeps } from "../../native-terminal-multipane/coordinator";
import { NATIVE_MULTIPANE_DIR_ENV } from "../../native-terminal-multipane/paths";
import type { NativeCaptureMode } from "../../native-terminal-registry/capture-mode";
import { readCaptureRecord } from "../../native-terminal-registry/capture-record";
import { readParserState } from "../../native-terminal-registry/parser-state";
import { captureRecordFile, parserStateFile } from "../../native-terminal-registry/paths";
import { defineShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { spawnSync } from "../../spawn";
import { isCapturedPane } from "../capture";
import type { TerminalAttachment } from "../contract";
import { NativeTerminalBackend } from "../native-backend";

const PANE_COUNTS = [1, 4, 6];
const MODES: NativeCaptureMode[] = ["none", "semantic", "compact", "semantic-and-compact"];
const LOADS = ["idle", "flood"] as const;
const ROUNDS = 3;
const COLS = 120;
const ROWS = 40;
const WARMUP_MS = 2_000;
const WINDOW_MS = 8_000;
const SAMPLE_MS = 250;
/** Paced so a flood is a busy agent pane, not a fork bomb. */
const FLOOD_LINES_PER_SECOND = 100;

type Load = (typeof LOADS)[number];

interface Measurement {
	round: number;
	panes: number;
	load: Load;
	mode: NativeCaptureMode;
	/** phys_footprint of the host processes, summed. Shared pages counted once. */
	footprintPeakBytes: number | null;
	/** Summed `ps rss`. OVERSTATES memory: shared pages counted once per process. */
	summedRssPeakBytes: number;
	cpuSecondsPerSecond: number;
	/** From write events on the artifact, not from polled sizes. */
	publishedBytesPerSecond: number;
	publishedWritesPerSecond: number;
	artifactBytesMean: number | null;
	/** Lines the shells were actually asked to print, per pane per second. */
	achievedLinesPerSecondPerPane: number;
	floodWriteFailures: number;
	lastChangeAgeP50Ms: number | null;
	lastChangeAgeP95Ms: number | null;
}

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";

/** The grid was not what the run claims, so no number from it may be reported. */
class RunAborted extends Error {}

function shellLaunch(cwd: string) {
	const base = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd, env: {} };
	return defineShellLaunchSpec(base);
}

function modeDeps(mode: NativeCaptureMode): Partial<CoordinatorDeps> {
	if (mode === "none") return {};
	return {
		startPane: (sessionId, opts) => defaultCoordinatorDeps.startPane(sessionId, { ...opts, captureMode: mode }),
	};
}

/** `ps time` is `[[dd-]hh:]mm:ss`. */
function parseCpuTime(value: string): number {
	const [clock, ...rest] = value.split("-").reverse();
	const days = rest.length > 0 ? Number(rest[0]) : 0;
	const parts = clock!.split(":").map(Number).reverse();
	return (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + days * 86_400;
}

/** One `ps` for every host pid at once; per-pid calls would dominate the CPU measured. */
function sampleProcesses(pids: number[]): { rssBytes: number; cpuSeconds: number } {
	if (pids.length === 0) return { rssBytes: 0, cpuSeconds: 0 };
	const res = spawnSync(["ps", "-o", "rss=,time=", "-p", pids.join(",")]);
	if (!res.success) return { rssBytes: 0, cpuSeconds: 0 };
	let rssBytes = 0;
	let cpuSeconds = 0;
	for (const line of new TextDecoder().decode(res.stdout).split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const rssKib = Number(parts[0]);
		if (Number.isFinite(rssKib)) rssBytes += rssKib * 1024;
		cpuSeconds += parseCpuTime(parts[1]!);
	}
	return { rssBytes, cpuSeconds };
}

/**
 * phys_footprint per process, which counts shared pages once — the honest answer
 * to "how much memory did this cost". `null` when the tool is unavailable.
 */
function samplePhysFootprint(pids: number[]): number | null {
	let total = 0;
	for (const pid of pids) {
		const res = spawnSync(["/usr/bin/footprint", "-p", String(pid)]);
		if (!res.success) return null;
		const match = /Footprint:\s+([\d.]+)\s*([KMG]?B)/.exec(new TextDecoder().decode(res.stdout));
		if (!match) return null;
		const scale = match[2] === "GB" ? 1024 ** 3 : match[2] === "MB" ? 1024 ** 2 : match[2] === "KB" ? 1024 : 1;
		total += Number(match[1]) * scale;
	}
	return total;
}

/**
 * Write accounting driven by the artifact's own publish events, not by sampling.
 *
 * macOS reports the CREATED name, which for an atomic publish is the temp file —
 * so the temp name is what identifies a write, and the temp file is what still
 * holds the bytes at that instant. Falling back to the artifact covers a rename
 * that already completed.
 */
function watchArtifacts(files: string[]): { stop: () => { writes: number; bytes: number } } {
	let writes = 0;
	let bytes = 0;
	const watchers = [...new Set(files.map((file) => join(file, "..")))].map((dir) => {
		const names = files.filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1));
		try {
			return watch(dir, (_event, changed) => {
				if (!changed) return;
				const artifact = names.find((name) => changed === name || changed.startsWith(`${name}.`));
				if (!artifact) return;
				for (const candidate of [join(dir, changed), join(dir, artifact)]) {
					try {
						bytes += statSync(candidate).size;
						writes++;
						return;
					} catch {
						// already renamed away; try the published artifact instead
					}
				}
			});
		} catch {
			return null;
		}
	});
	return {
		stop() {
			for (const watcher of watchers) watcher?.close();
			return { writes, bytes };
		},
	};
}

function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function mib(bytes: number | null): string {
	return bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function runOnce(round: number, panes: number, load: Load, mode: NativeCaptureMode): Promise<Measurement> {
	const sessionId = `cost-r${round}-${panes}-${load}-${mode.replaceAll("-", "")}`;
	const backend = new NativeTerminalBackend({ deps: modeDeps(mode) });
	const launch = shellLaunch(process.cwd());
	try {
		const created = await backend.openSession({
			id: sessionId,
			cwd: process.cwd(),
			launch: { executable: launch.executable, argv: [...launch.argv] },
			size: { cols: COLS, rows: ROWS },
		});
		let from = created.views[0]!.id;
		for (let i = 1; i < panes; i++) {
			const view = await backend.splitView(sessionId, from, { cwd: process.cwd() });
			from = view.id;
		}

		// One long-lived writer per pane. Writing through a fresh connection per line
		// loses the writer lease under any concurrency, which silently rejected most of
		// the flood at four panes and up — the load was then not the load claimed.
		const writers = new Map<string, TerminalAttachment>();
		for (const pane of (await backend.listPanes(sessionId)) ?? []) {
			const attachment = await backend.attachView(sessionId, pane.paneId);
			writers.set(pane.paneId, attachment);
			// A split pane inherits the backend default, so every pane is resized
			// explicitly and then VERIFIED from its record below. A mixed grid is not a
			// slower measurement, it is a different one.
			await attachment.resize({ cols: COLS, rows: ROWS });
		}
		const paneSet = (await backend.listPanes(sessionId)) ?? [];
		if (paneSet.length !== panes) throw new RunAborted(`expected ${panes} pane(s), found ${paneSet.length}`);
		for (const pane of paneSet) {
			if (pane.cols !== COLS || pane.rows !== ROWS) {
				throw new RunAborted(`pane ${pane.paneId} is ${pane.cols}x${pane.rows}, not ${COLS}x${ROWS}`);
			}
		}

		const hostPids = paneSet.map((pane) => pane.hostPid).filter((pid) => pid > 0);
		const artifacts = paneSet.flatMap((pane) => [
			captureRecordFile(pane.sessionId),
			parserStateFile(pane.sessionId),
		]);

		// One echo per tick per pane, every write awaited and counted. A `while true`
		// in the shell would peg a core and swamp the delta being measured.
		const stop = { done: false };
		let floodLines = 0;
		let floodWriteFailures = 0;
		const flood = (async () => {
			if (load !== "flood") return;
			const intervalMs = 1000 / FLOOD_LINES_PER_SECOND;
			let line = 0;
			while (!stop.done) {
				// All panes in parallel per tick: a sequential loop made the achieved rate
				// fall with the pane count, so the arms would have been compared under
				// different loads at different widths.
				const results = await Promise.allSettled(
					paneSet.map((pane) => writers.get(pane.paneId)!.write(`echo flood-${line}${lineEnd}`)),
				);
				for (const result of results) {
					if (result.status === "fulfilled") floodLines++;
					else floodWriteFailures++;
				}
				line++;
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
		})();

		await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));

		const first = sampleProcesses(hostPids);
		const floodAtStart = floodLines;
		const watcher = watchArtifacts(artifacts);
		const rssSamples: number[] = [];
		const footprintSamples: number[] = [];
		const ages: number[] = [];
		const artifactSizes: number[] = [];
		const startedAt = Date.now();
		while (Date.now() - startedAt < WINDOW_MS) {
			rssSamples.push(sampleProcesses(hostPids).rssBytes);
			const footprint = samplePhysFootprint(hostPids);
			if (footprint !== null) footprintSamples.push(footprint);
			const capture = await backend.captureView(sessionId, paneSet[0]!.paneId);
			if (isCapturedPane(capture) && capture.lastChangeAgeMs.known) ages.push(capture.lastChangeAgeMs.value);
			for (const file of artifacts) {
				try {
					artifactSizes.push(statSync(file).size);
				} catch {
					// this mode does not publish that artifact
				}
			}
			await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
		}
		const elapsedSeconds = (Date.now() - startedAt) / 1000;
		const published = watcher.stop();
		const last = sampleProcesses(hostPids);
		const floodInWindow = floodLines - floodAtStart;

		stop.done = true;
		await flood;
		for (const attachment of writers.values()) await attachment.detach();

		// A load that did not happen is not the load this run claims, so any rejected
		// write invalidates the comparison rather than being reported beside it.
		if (floodWriteFailures > 0) {
			throw new RunAborted(`${floodWriteFailures} flood write(s) were rejected`);
		}

		// Dual mode must describe the pane the same way through both artifacts, or the
		// comparison is between two different observations.
		if (mode === "semantic-and-compact") {
			for (const pane of paneSet) {
				const compact = readCaptureRecord(pane.sessionId);
				const snapshot = readParserState(pane.sessionId);
				if (!compact || !snapshot?.state) {
					throw new RunAborted(`dual mode published only one artifact for ${pane.paneId}`);
				}
				if (compact.cols !== snapshot.state.dimensions.cols || compact.rows !== snapshot.state.dimensions.rows) {
					throw new RunAborted(`dual artifacts disagree on geometry for ${pane.paneId}`);
				}
				if (compact.health.status !== snapshot.health.status) {
					throw new RunAborted(`dual artifacts disagree on health for ${pane.paneId}`);
				}
			}
		}

		return {
			round,
			panes,
			load,
			mode,
			footprintPeakBytes: footprintSamples.length > 0 ? Math.max(...footprintSamples) : null,
			summedRssPeakBytes: Math.max(...rssSamples, 0),
			cpuSecondsPerSecond: (last.cpuSeconds - first.cpuSeconds) / elapsedSeconds,
			publishedBytesPerSecond: published.bytes / elapsedSeconds,
			publishedWritesPerSecond: published.writes / elapsedSeconds,
			artifactBytesMean:
				artifactSizes.length > 0 ? artifactSizes.reduce((a, b) => a + b, 0) / artifactSizes.length : null,
			achievedLinesPerSecondPerPane: floodInWindow / elapsedSeconds / panes,
			floodWriteFailures,
			lastChangeAgeP50Ms: percentile(ages, 50),
			lastChangeAgeP95Ms: percentile(ages, 95),
		};
	} finally {
		await backend.cleanupSession(sessionId, { ignoreMissing: true });
		await backend.dispose();
	}
}

function summarize(results: Measurement[]): void {
	const key = (m: Measurement) => `${m.panes}|${m.load}`;
	for (const group of [...new Set(results.map(key))]) {
		const rows = results.filter((m) => key(m) === group);
		const baseline = rows.filter((m) => m.mode === "none");
		const [panes, load] = group.split("|");
		console.log(`\n${panes} pane(s) ${load} — ${COLS}x${ROWS}, ${ROUNDS} rounds, delta vs mode none`);
		for (const mode of MODES) {
			const arm = rows.filter((m) => m.mode === mode);
			if (arm.length === 0) continue;
			const dFootprint = arm.map((m, i) => (m.footprintPeakBytes ?? 0) - (baseline[i]?.footprintPeakBytes ?? 0));
			const dRss = arm.map((m, i) => m.summedRssPeakBytes - (baseline[i]?.summedRssPeakBytes ?? 0));
			const dCpu = arm.map((m, i) => m.cpuSecondsPerSecond - (baseline[i]?.cpuSecondsPerSecond ?? 0));
			const published = arm.map((m) => m.publishedBytesPerSecond);
			const achieved = arm.map((m) => m.achievedLinesPerSecondPerPane);
			console.log(
				[
					`  ${mode.padEnd(21)}`,
					`Δfootprint ${mib(percentile(dFootprint, 0))} / ${mib(percentile(dFootprint, 50))} / ${mib(percentile(dFootprint, 95))}`,
					`Δrss(overstates) p50 ${mib(percentile(dRss, 50))}`,
					`ΔCPU p50 ${((percentile(dCpu, 50) ?? 0) * 100).toFixed(1)}%`,
					`published p50 ${((percentile(published, 50) ?? 0) / 1024).toFixed(1)} KiB/s`,
					`achieved p50 ${(percentile(achieved, 50) ?? 0).toFixed(1)} lines/s/pane`,
					`writeFailures ${arm.reduce((total, m) => total + m.floodWriteFailures, 0)}`,
				].join(" | "),
			);
		}
	}
}

async function main(): Promise<void> {
	if (isWindows) {
		console.error("This harness reads RSS and CPU via POSIX `ps`; run it on macOS or Linux.");
		process.exit(2);
	}
	const root = mkdtempSync(join(tmpdir(), "dev3-capture-cost-"));
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "multipane");
	console.log(
		`capture cost — ${COLS}x${ROWS} panes, ${WINDOW_MS / 1000}s window after ${WARMUP_MS / 1000}s warmup, ` +
			`flood paced at ${FLOOD_LINES_PER_SECOND} lines/s/pane, ${ROUNDS} rounds, arm order rotated per round`,
	);

	const results: Measurement[] = [];
	try {
		for (let round = 0; round < ROUNDS; round++) {
			for (const panes of PANE_COUNTS) {
				for (const load of LOADS) {
					const shift = round % MODES.length;
					for (const mode of [...MODES.slice(shift), ...MODES.slice(0, shift)]) {
						const measurement = await runOnce(round, panes, load, mode);
						results.push(measurement);
						console.log(
							`  round ${round} ${panes}p ${load} ${mode}: footprint ${mib(measurement.footprintPeakBytes)}, ` +
								`published ${(measurement.publishedBytesPerSecond / 1024).toFixed(1)} KiB/s, ` +
								`achieved ${measurement.achievedLinesPerSecondPerPane.toFixed(1)} lines/s/pane`,
						);
					}
				}
			}
		}
	} catch (err) {
		if (err instanceof RunAborted) {
			console.error(`\nRUN ABORTED — the grid was not what it claims: ${err.message}`);
			process.exit(1);
		}
		throw err;
	}

	summarize(results);
	console.log("\nraw rounds (JSON):");
	console.log(JSON.stringify(results, null, 2));

	delete process.env[NATIVE_MULTIPANE_DIR_ENV];
	rmSync(root, { recursive: true, force: true });
}

await main();
