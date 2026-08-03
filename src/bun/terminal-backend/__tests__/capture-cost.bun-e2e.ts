#!/usr/bin/env bun
/**
 * INCREMENTAL cost of the host live parser, measured on real panes (seq 1412,
 * Fork 1 of the tmux-removal roadmap).
 *
 * The activation question is not "what does a parser-enabled host cost" but
 * "what does turning it ON add", so every configuration is run TWICE — identical
 * panes, identical shell load, parser off then parser on — and only the delta is
 * reported. Anything else measures the shell, the OS, and the machine's mood.
 *
 * Grid: 1 / 4 / 6 real panes × idle and a paced flood × THREE arms —
 * parser off, parser on with the per-cell snapshot, and parser on with the
 * compact plain-text projection. The third arm is what isolates parser memory
 * from JSON allocation and disk churn: same parsing, same panes, only the
 * published artifact changes.
 * Measured per run: resident memory of the HOST processes only (the shells are
 * excluded — their load is the constant), host CPU seconds, parser-state bytes
 * written per second, snapshot cadence, and the seam's own `lastChangeAgeMs`
 * (under flood, how far behind the pane the published content is).
 *
 * Read-only with respect to production: the parser is enabled by overriding the
 * coordinator's pane start INSIDE this file. Nothing here changes what the app
 * launches. Run it with `bun run test:capture-cost-e2e`.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultCoordinatorDeps,
	type CoordinatorDeps,
	type PaneSnapshot,
} from "../../native-terminal-multipane/coordinator";
import { NATIVE_MULTIPANE_DIR_ENV } from "../../native-terminal-multipane/paths";
import type { NativeCaptureMode } from "../../native-terminal-registry/capture-mode";
import { captureRecordFile, parserStateFile } from "../../native-terminal-registry/paths";
import { defineShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { spawnSync } from "../../spawn";
import { NativeTerminalBackend } from "../native-backend";
import { isCapturedPane } from "../capture";

const PANE_COUNTS = [1, 4, 6];
const MODES = ["idle", "flood"] as const;
const WARMUP_MS = 2_000;
const WINDOW_MS = 8_000;
const SAMPLE_MS = 50;
/** Paced so the flood is a realistic agent pane, not a fork bomb. */
const FLOOD_LINES_PER_SECOND = 100;

/** Which capture surface the pane's host publishes, if any. */
type Arm = "off" | "snapshot" | "projection" | "dual";
const ARMS: Arm[] = ["off", "snapshot", "projection", "dual"];

type Mode = (typeof MODES)[number];

interface Sample {
	/** Resident memory of the host processes, summed, in bytes. */
	rssBytes: number;
	/** CPU seconds the host processes have consumed since they started. */
	cpuSeconds: number;
}

interface RunResult {
	panes: number;
	mode: Mode;
	arm: Arm;
	rssPeakBytes: number;
	rssMeanBytes: number;
	cpuSecondsPerSecond: number;
	parserBytesPerSecond: number;
	snapshotWritesPerSecond: number;
	snapshotCadenceP50Ms: number | null;
	ageP50Ms: number | null;
	ageP95Ms: number | null;
	/** Snapshot bytes per write — the size of one persisted screen. */
	snapshotBytesMean: number | null;
}

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";

function shellLaunch(cwd: string) {
	const base = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd, env: {} };
	return defineShellLaunchSpec(base);
}

const ARM_MODES: Record<Arm, NativeCaptureMode> = {
	off: "none",
	snapshot: "semantic",
	projection: "compact",
	dual: "semantic-and-compact",
};

function armDeps(arm: Arm): Partial<CoordinatorDeps> {
	const captureMode = ARM_MODES[arm];
	if (captureMode === "none") return {};
	return {
		startPane: (sessionId, opts) => defaultCoordinatorDeps.startPane(sessionId, { ...opts, captureMode }),
	};
}

/** One `ps` call for every host pid at once — per-pid calls would dominate the CPU we measure. */
function sampleHosts(pids: number[]): Sample {
	if (pids.length === 0) return { rssBytes: 0, cpuSeconds: 0 };
	if (isWindows) return { rssBytes: 0, cpuSeconds: 0 }; // ps is POSIX-only; see the note in main()
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

/** `ps time` is `[[dd-]hh:]mm:ss`. */
function parseCpuTime(value: string): number {
	const [clock, ...rest] = value.split("-").reverse();
	const days = rest.length > 0 ? Number(rest[0]) : 0;
	const parts = clock!.split(":").map(Number).reverse();
	const seconds = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
	return seconds + days * 86_400;
}

function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function pacedFlood(
	backend: NativeTerminalBackend,
	sessionId: string,
	panes: PaneSnapshot[],
	stop: { done: boolean },
): Promise<void> {
	// One echo per tick per pane: a `while true` loop in the shell would peg a core
	// and swamp the very delta we are trying to see.
	const intervalMs = 1000 / FLOOD_LINES_PER_SECOND;
	let line = 0;
	while (!stop.done) {
		for (const pane of panes) {
			await backend.writePane(sessionId, pane.paneId, `echo flood-${line}${lineEnd}`).catch(() => {});
		}
		line++;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

async function runOnce(panes: number, mode: Mode, arm: Arm): Promise<RunResult> {
	const sessionId = `cost-${panes}-${mode}-${arm}`;
	const backend = new NativeTerminalBackend({ deps: armDeps(arm) });
	const launch = shellLaunch(process.cwd());
	try {
		const created = await backend.openSession({
			id: sessionId,
			cwd: process.cwd(),
			launch: { executable: launch.executable, argv: [...launch.argv] },
			size: { cols: 120, rows: 40 },
		});
		let from = created.views[0]!.id;
		for (let i = 1; i < panes; i++) {
			const view = await backend.splitView(sessionId, from, { cwd: process.cwd() });
			from = view.id;
		}
		const paneSet = (await backend.listPanes(sessionId)) ?? [];
		const hostPids = paneSet.map((pane) => pane.hostPid).filter((pid) => pid > 0);

		const stop = { done: false };
		const flood = mode === "flood" ? pacedFlood(backend, sessionId, paneSet, stop) : Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));

		const first = sampleHosts(hostPids);
		const rssSamples: number[] = [];
		const cadence: number[] = [];
		const ages: number[] = [];
		// Watch whichever artifact this arm actually publishes.
		const stateFiles = paneSet.map((pane) =>
			arm === "projection" ? captureRecordFile(pane.sessionId) : parserStateFile(pane.sessionId),
		);
		let parserBytes = 0;
		let snapshotWrites = 0;
		const lastSeen = new Map<string, { mtimeMs: number; size: number }>();
		// Cadence is per PANE: interleaving six files into one series measures the
		// poll loop, not the parser's write rhythm.
		const lastWriteAt = new Map<string, number>();

		const startedAt = Date.now();
		while (Date.now() - startedAt < WINDOW_MS) {
			const sample = sampleHosts(hostPids);
			rssSamples.push(sample.rssBytes);
			for (const file of stateFiles) {
				let stat: { mtimeMs: number; size: number };
				try {
					const info = statSync(file);
					stat = { mtimeMs: info.mtimeMs, size: info.size };
				} catch {
					continue;
				}
				const previous = lastSeen.get(file);
				if (!previous || stat.mtimeMs !== previous.mtimeMs) {
					lastSeen.set(file, stat);
					if (previous) {
						parserBytes += stat.size;
						snapshotWrites++;
						const now = Date.now();
						const seen = lastWriteAt.get(file);
						if (seen !== undefined) cadence.push(now - seen);
						lastWriteAt.set(file, now);
					}
				}
			}
			// How long ago the content last changed, straight from the seam. Under flood
			// this IS the observation lag; when idle it is just how quiet the pane is.
			const capture = await backend.captureView(sessionId, paneSet[0]!.paneId);
			if (isCapturedPane(capture) && capture.lastChangeAgeMs.known) ages.push(capture.lastChangeAgeMs.value);
			await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
		}
		const last = sampleHosts(hostPids);
		const elapsedSeconds = (Date.now() - startedAt) / 1000;

		stop.done = true;
		await flood;

		return {
			panes,
			mode,
			arm,
			rssPeakBytes: Math.max(...rssSamples, 0),
			rssMeanBytes: rssSamples.reduce((a, b) => a + b, 0) / Math.max(1, rssSamples.length),
			cpuSecondsPerSecond: (last.cpuSeconds - first.cpuSeconds) / elapsedSeconds,
			parserBytesPerSecond: parserBytes / elapsedSeconds,
			snapshotWritesPerSecond: snapshotWrites / elapsedSeconds,
			snapshotCadenceP50Ms: percentile(cadence, 50),
			ageP50Ms: percentile(ages, 50),
			ageP95Ms: percentile(ages, 95),
			snapshotBytesMean: snapshotWrites > 0 ? parserBytes / snapshotWrites : null,
		};
	} finally {
		await backend.cleanupSession(sessionId, { ignoreMissing: true });
		await backend.dispose();
	}
}

function reportDelta(off: RunResult, on: RunResult): void {
	const deltaRss = on.rssPeakBytes - off.rssPeakBytes;
	console.log(
		[
			`  ${String(on.panes).padStart(2)} pane(s) ${on.mode.padEnd(5)} ${on.arm.padEnd(10)}`,
			`RSS ${mib(off.rssPeakBytes)} -> ${mib(on.rssPeakBytes)}`,
			`(+${mib(deltaRss)}, +${mib(deltaRss / on.panes)}/pane)`,
			`CPU ${(off.cpuSecondsPerSecond * 100).toFixed(1)}% -> ${(on.cpuSecondsPerSecond * 100).toFixed(1)}%`,
			`published ${(on.parserBytesPerSecond / 1024).toFixed(1)} KiB/s`,
			`writes ${on.snapshotWritesPerSecond.toFixed(2)}/s`,
			`cadence p50 ${on.snapshotCadenceP50Ms ?? "-"}ms`,
			`artifact ${on.snapshotBytesMean === null ? "-" : `${(on.snapshotBytesMean / 1024).toFixed(1)} KiB`}`,
			`lastChange p50/p95 ${on.ageP50Ms ?? "-"}/${on.ageP95Ms ?? "-"}ms`,
		].join(" | "),
	);
}

async function main(): Promise<void> {
	if (isWindows) {
		console.error("This harness reads RSS and CPU via POSIX `ps`; run it on macOS or Linux.");
		process.exit(2);
	}
	const root = mkdtempSync(join(tmpdir(), "dev3-capture-cost-"));
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "multipane");

	console.log(
		`incremental live-parser cost — ${WINDOW_MS / 1000}s window after ${WARMUP_MS / 1000}s warmup, ` +
			`flood paced at ${FLOOD_LINES_PER_SECOND} lines/s/pane, 120x40 panes`,
	);
	const results: RunResult[] = [];
	for (const panes of PANE_COUNTS) {
		for (const mode of MODES) {
			// The OFF arm is the baseline both parser arms are compared against, so it
			// runs once per configuration and is reused.
			const off = await runOnce(panes, mode, "off");
			results.push(off);
			for (const arm of ARMS.filter((entry) => entry !== "off")) {
				const on = await runOnce(panes, mode, arm);
				results.push(on);
				reportDelta(off, on);
			}
		}
	}

	console.log("\nraw results (JSON, for the roadmap record):");
	console.log(JSON.stringify(results, null, 2));

	delete process.env[NATIVE_MULTIPANE_DIR_ENV];
	rmSync(root, { recursive: true, force: true });
}

await main();
