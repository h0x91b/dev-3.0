#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { cpus, machine, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import {
	HeadlessTerminalState,
	decodeCaptureOutput,
	replayTerminalSnapshot,
	serializeTerminalSnapshot,
	type TerminalCaptureEvent,
	type TerminalCaptureFixture,
	type TerminalDimensions,
} from "./terminal-state";

interface BenchmarkCase {
	name: string;
	initial: TerminalDimensions;
	events: TerminalCaptureEvent[];
}

interface MemorySample {
	rssBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
}

const REPLAY_RUNS = 30;
const RETAINED_CLIENTS = 8;

function loadFixture(name: string): TerminalCaptureFixture {
	const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as TerminalCaptureFixture;
}

function fixtureCase(name: string): BenchmarkCase {
	const fixture = loadFixture(name);
	return { name, initial: fixture.initial, events: fixture.events };
}

function boundedHistoryCase(): BenchmarkCase {
	const lines = Array.from(
		{ length: 400 },
		(_, index) =>
			`\x1b[38;5;${index % 256}mline-${String(index).padStart(3, "0")} ` +
			`wide=界 combining=é emoji=🙂 ${"payload ".repeat(5)}\x1b[0m`,
	);
	return {
		name: "bounded-400-line-history",
		initial: { cols: 100, rows: 30, scrollback: 500 },
		events: [{ type: "output", data: lines.join("\r\n") }],
	};
}

async function applyEvents(state: HeadlessTerminalState, events: TerminalCaptureEvent[]): Promise<void> {
	for (const event of events) {
		if (event.type === "output") await state.ingest(decodeCaptureOutput(event));
		else state.resize(event.cols, event.rows);
	}
}

function inputSize(events: TerminalCaptureEvent[]): number {
	return events.reduce((bytes, event) => {
		if (event.type === "resize") return bytes;
		const data = decodeCaptureOutput(event);
		return bytes + (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
	}, 0);
}

function percentile(sorted: number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function sampleMemory(): MemorySample {
	const memory = process.memoryUsage();
	return {
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
	};
}

function perClientDelta(before: MemorySample, after: MemorySample): MemorySample {
	return {
		rssBytes: Math.max(0, after.rssBytes - before.rssBytes) / RETAINED_CLIENTS,
		heapUsedBytes: Math.max(0, after.heapUsedBytes - before.heapUsedBytes) / RETAINED_CLIENTS,
		externalBytes: Math.max(0, after.externalBytes - before.externalBytes) / RETAINED_CLIENTS,
	};
}

async function measureCase(benchmark: BenchmarkCase) {
	const source = await HeadlessTerminalState.create(benchmark.initial);
	await applyEvents(source, benchmark.events);
	const expected = source.inspect();
	const snapshot = source.snapshot();
	const snapshotBytes = Buffer.byteLength(serializeTerminalSnapshot(snapshot));
	source.dispose();

	const durations: number[] = [];
	for (let run = 0; run < REPLAY_RUNS; run++) {
		const startedAt = performance.now();
		const replay = await replayTerminalSnapshot(snapshot);
		const actual = replay.inspect();
		durations.push(performance.now() - startedAt);
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			replay.dispose();
			throw new Error(`${benchmark.name}: replay changed semantic state`);
		}
		replay.dispose();
	}
	durations.sort((left, right) => left - right);

	return {
		name: benchmark.name,
		inputBytes: inputSize(benchmark.events),
		snapshotBytes,
		snapshotToInputRatio: Number((snapshotBytes / inputSize(benchmark.events)).toFixed(2)),
		replayMedianMs: Number(percentile(durations, 0.5).toFixed(3)),
		replayP95Ms: Number(percentile(durations, 0.95).toFixed(3)),
	};
}

async function measureRetainedClients(benchmark: BenchmarkCase): Promise<MemorySample> {
	const source = await HeadlessTerminalState.create(benchmark.initial);
	await applyEvents(source, benchmark.events);
	const snapshot = source.snapshot();
	source.dispose();
	Bun.gc(true);
	const before = sampleMemory();
	const clients: HeadlessTerminalState[] = [];
	for (let index = 0; index < RETAINED_CLIENTS; index++) {
		const client = await replayTerminalSnapshot(snapshot);
		client.inspect();
		clients.push(client);
	}
	Bun.gc(true);
	const after = sampleMemory();
	for (const client of clients) client.dispose();
	return perClientDelta(before, after);
}

const benchmarks = [
	fixtureCase("active-screen"),
	fixtureCase("resize-history"),
	boundedHistoryCase(),
	fixtureCase("real-powershell"),
	fixtureCase("real-nvim"),
];
const cases = [];
for (const benchmark of benchmarks) cases.push(await measureCase(benchmark));
const retainedPerClient = await measureRetainedClients(benchmarks[benchmarks.length - 1]!);

console.log(
	JSON.stringify(
		{
			measuredAt: new Date().toISOString(),
			runtime: `Bun ${Bun.version}`,
			platform: `${platform()} ${release()} ${machine()}`,
			cpu: cpus()[0]?.model ?? "unknown",
			replayRuns: REPLAY_RUNS,
			retainedClients: RETAINED_CLIENTS,
			retainedPerClient,
			cases,
		},
		null,
		2,
	),
);
