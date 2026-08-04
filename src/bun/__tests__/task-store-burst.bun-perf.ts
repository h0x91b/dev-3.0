/**
 * Burst profiler for the real task-store seam (`bun run perf:task-store`). Private
 * HOME, seeded fixture, never touches the real store; there is no fsync on this path,
 * so nothing here speaks to crash durability. See the closing note for scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";

// require, not a static import: a static `node:fs` binding materialises the builtin
// namespace and the instrumentation below would never be seen by the app modules.
const { mkdirSync, rmSync, writeFileSync, statSync } = require("node:fs");
import { buildFixtureTasks, fixtureProject, FIXTURE_PROJECT_SLUG } from "./task-store-fixture";

const TASK_COUNT = Number(process.env.PERF_TASK_COUNT ?? 1509);
const BURST_SIZE = Number(process.env.PERF_BURST_SIZE ?? 10);
const BURST_SPREAD_MS = Number(process.env.PERF_BURST_SPREAD_MS ?? 600);
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3);

// ---- private HOME (must be set before ./paths is ever imported) ----

const home = `${tmpdir()}/dev3-task-store-perf-${process.pid}`;
rmSync(home, { recursive: true, force: true });
process.env.HOME = home;
process.env.DEV3_LOG_LEVEL ??= "error";
const dataDir = `${home}/.dev3.0/data/${FIXTURE_PROJECT_SLUG}`;
mkdirSync(dataDir, { recursive: true });

const project = fixtureProject();
const tasks = buildFixtureTasks(TASK_COUNT);
const tasksFile = `${dataDir}/tasks.json`;
const fixtureJson = JSON.stringify(tasks, null, 2);
writeFileSync(tasksFile, fixtureJson);
writeFileSync(`${home}/.dev3.0/projects.json`, JSON.stringify([project], null, 2));

// ---- instrumentation ----

interface JsonStats {
	parseCalls: number;
	parseMs: number;
	parseBytes: number;
	stringifyCalls: number;
	stringifyMs: number;
	stringifyBytes: number;
}

const json: JsonStats = {
	parseCalls: 0, parseMs: 0, parseBytes: 0,
	stringifyCalls: 0, stringifyMs: 0, stringifyBytes: 0,
};

/** Only count whole-store work; small log/config payloads are noise. */
const BIG = 100_000;
const origParse = JSON.parse;
const origStringify = JSON.stringify;
JSON.parse = ((text: string, ...rest: unknown[]) => {
	const big = typeof text === "string" && text.length >= BIG;
	if (!big) return (origParse as any)(text, ...rest);
	const t0 = Bun.nanoseconds();
	const out = (origParse as any)(text, ...rest);
	json.parseCalls++;
	json.parseMs += (Bun.nanoseconds() - t0) / 1e6;
	json.parseBytes += text.length;
	return out;
}) as typeof JSON.parse;
JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
	const t0 = Bun.nanoseconds();
	const out = (origStringify as any)(value, ...rest);
	if (typeof out === "string" && out.length >= BIG) {
		json.stringifyCalls++;
		json.stringifyMs += (Bun.nanoseconds() - t0) / 1e6;
		json.stringifyBytes += out.length;
	}
	return out;
}) as typeof JSON.stringify;

function resetJson(): void {
	json.parseCalls = 0; json.parseMs = 0; json.parseBytes = 0;
	json.stringifyCalls = 0; json.stringifyMs = 0; json.stringifyBytes = 0;
}

/** Disk volume moved, plus how long publishing took: writeFile + rename, no fsync. */
interface IoStats {
	reads: number;
	readBytes: number;
	writes: number;
	writeBytes: number;
	/** writeFile + rename per save, in ms. Excludes stat and cache priming. */
	writeMs: number[];
}

const io: IoStats = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, writeMs: [] };

function resetIo(): void {
	io.reads = 0; io.readBytes = 0; io.writes = 0; io.writeBytes = 0; io.writeMs = [];
}

{
	const fsp = require("node:fs/promises");
	const origRead = fsp.readFile;
	const origWrite = fsp.writeFile;
	fsp.readFile = async (path: any, ...rest: any[]) => {
		const out = await origRead(path, ...rest);
		if (String(path).includes("/data/")) {
			io.reads++;
			io.readBytes += typeof out === "string" ? out.length : out.byteLength;
		}
		return out;
	};
	const origRename = fsp.rename;
	fsp.writeFile = async (path: any, content: any, ...rest: any[]) => {
		const track = String(path).includes("/data/");
		if (!track) return origWrite(path, content, ...rest);
		io.writes++;
		io.writeBytes += typeof content === "string" ? content.length : content.byteLength;
		const t0 = Bun.nanoseconds();
		const out = await origWrite(path, content, ...rest);
		pendingWriteMs = (Bun.nanoseconds() - t0) / 1e6;
		return out;
	};
	fsp.rename = async (from: any, to: any) => {
		const track = String(to).includes("/data/");
		const t0 = Bun.nanoseconds();
		const out = await origRename(from, to);
		if (track) {
			io.writeMs.push(pendingWriteMs + (Bun.nanoseconds() - t0) / 1e6);
			pendingWriteMs = 0;
		}
		return out;
	};
}

let pendingWriteMs = 0;

/**
 * File-lock cost, split into the two things it actually charges: sync time inside
 * the mkdir/rmdir syscalls, and the queueing wait each caller spent from its first
 * EEXIST to acquiring the lock (tracked per mutation through AsyncLocalStorage).
 */
interface LockStats {
	acquires: number;
	collisions: number;
	syncMs: number;
	waitMs: number[];
}

const lock: LockStats = { acquires: 0, collisions: 0, syncMs: 0, waitMs: [] };
const lockCtx = new AsyncLocalStorage<{ firstFail: number }>();

function resetLock(): void {
	lock.acquires = 0; lock.collisions = 0; lock.syncMs = 0; lock.waitMs = [];
}

{
	const fsSync = require("node:fs");
	const origMkdir = fsSync.mkdirSync;
	const origRmdir = fsSync.rmdirSync;
	fsSync.mkdirSync = (p: any, ...rest: any[]) => {
		if (!String(p).endsWith(".lock")) return origMkdir(p, ...rest);
		const ctx = lockCtx.getStore();
		const t0 = Bun.nanoseconds();
		try {
			const out = origMkdir(p, ...rest);
			lock.acquires++;
			if (ctx) lock.waitMs.push(ctx.firstFail ? (Bun.nanoseconds() - ctx.firstFail) / 1e6 : 0);
			return out;
		} catch (err: any) {
			if (err?.code === "EEXIST") {
				lock.collisions++;
				if (ctx && !ctx.firstFail) ctx.firstFail = Bun.nanoseconds();
			}
			throw err;
		} finally {
			lock.syncMs += (Bun.nanoseconds() - t0) / 1e6;
		}
	};
	fsSync.rmdirSync = (p: any, ...rest: any[]) => {
		if (!String(p).endsWith(".lock")) return origRmdir(p, ...rest);
		const t0 = Bun.nanoseconds();
		try {
			return origRmdir(p, ...rest);
		} finally {
			lock.syncMs += (Bun.nanoseconds() - t0) / 1e6;
		}
	};
}

/** Event-loop delay sampler: how long a 2 ms timer was actually starved. */
class LoopSampler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private last = 0;
	readonly samples: number[] = [];
	start(): void {
		this.samples.length = 0;
		this.last = Bun.nanoseconds();
		this.timer = setInterval(() => {
			const now = Bun.nanoseconds();
			this.samples.push((now - this.last) / 1e6 - 2);
			this.last = now;
		}, 2);
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
	stats() {
		const s = [...this.samples].sort((a, b) => a - b);
		const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0);
		return {
			count: s.length,
			p50: at(0.5),
			p99: at(0.99),
			max: s.length ? s[s.length - 1] : 0,
			over16: s.filter((v) => v > 16).length,
			over50: s.filter((v) => v > 50).length,
			blockedMs: s.filter((v) => v > 2).reduce((a, b) => a + b, 0),
		};
	}
}

function pct(values: number[], q: number): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

const fmt = (n: number) => n.toFixed(2);

// ---- the harness ----

const data = await import("../data");

function restoreFixture(): void {
	writeFileSync(tasksFile, fixtureJson);
	data._resetDataCaches();
}

interface RoundResult {
	label: string;
	burstMs: number;
	mutationMs: number[];
	loop: ReturnType<LoopSampler["stats"]>;
	json: JsonStats;
	io: IoStats;
	lock: LockStats;
	fileBytes: number;
}

async function runRound(label: string, drive: () => Promise<void>): Promise<RoundResult> {
	restoreFixture();
	resetJson();
	resetIo();
	resetLock();
	const sampler = new LoopSampler();
	sampler.start();
	const t0 = Bun.nanoseconds();
	await drive();
	const burstMs = (Bun.nanoseconds() - t0) / 1e6;
	sampler.stop();
	return {
		label,
		burstMs,
		mutationMs: [...mutationMs],
		loop: sampler.stats(),
		json: { ...json },
		io: { ...io, writeMs: [...io.writeMs] },
		lock: { ...lock, waitMs: [...lock.waitMs] },
		fileBytes: statSync(tasksFile).size,
	};
}

let mutationMs: number[] = [];

/** Sequential burst on ONE task — the ordering/lossless correctness scenario. */
async function sequentialBurst(): Promise<void> {
	mutationMs = [];
	const target = tasks[Math.floor(tasks.length / 2)];
	for (let i = 1; i <= BURST_SIZE; i++) {
		const t0 = Bun.nanoseconds();
		const current = await data.getTask(project, target.id);
		await lockCtx.run({ firstFail: 0 }, () =>
			data.updateTask(project, target.id, { overview: `${current.overview ?? ""}|${i}` }),
		);
		mutationMs.push((Bun.nanoseconds() - t0) / 1e6);
	}
}

/** Distinct, evenly-spread targets so a burst touches the whole store. */
function burstTargetIndex(i: number): number {
	return Math.floor((i * TASK_COUNT) / BURST_SIZE);
}

/** Concurrent burst spread over BURST_SPREAD_MS — the live latency scenario. */
async function concurrentBurst(): Promise<void> {
	mutationMs = [];
	const step = BURST_SPREAD_MS / BURST_SIZE;
	const inflight: Promise<void>[] = [];
	for (let i = 0; i < BURST_SIZE; i++) {
		const target = tasks[burstTargetIndex(i)];
		inflight.push(
			(async () => {
				await Bun.sleep(i * step);
				const t0 = Bun.nanoseconds();
				await lockCtx.run({ firstFail: 0 }, () => data.updateTask(project, target.id, { overview: `burst-${i}` }));
				mutationMs.push((Bun.nanoseconds() - t0) / 1e6);
			})(),
		);
	}
	await Promise.all(inflight);
}

const COLUMNS: Array<{ head: string; pick: (r: RoundResult) => number }> = [
	{ head: "burst ms", pick: (r) => r.burstMs },
	{ head: "mut p50", pick: (r) => pct(r.mutationMs, 0.5) },
	{ head: "mut max", pick: (r) => Math.max(...r.mutationMs) },
	{ head: "loop p99", pick: (r) => r.loop.p99 },
	{ head: "loop max", pick: (r) => r.loop.max },
	{ head: ">16ms", pick: (r) => r.loop.over16 },
	{ head: ">50ms", pick: (r) => r.loop.over50 },
	{ head: "blocked ms", pick: (r) => r.loop.blockedMs },
	{ head: "parses", pick: (r) => r.json.parseCalls },
	{ head: "parse ms", pick: (r) => r.json.parseMs },
	{ head: "serials", pick: (r) => r.json.stringifyCalls },
	{ head: "serial ms", pick: (r) => r.json.stringifyMs },
	{ head: "lock hits", pick: (r) => r.lock.collisions },
	{ head: "lock sync", pick: (r) => r.lock.syncMs },
	{ head: "lockwait p50", pick: (r) => pct(r.lock.waitMs, 0.5) },
	{ head: "lockwait max", pick: (r) => (r.lock.waitMs.length ? Math.max(...r.lock.waitMs) : 0) },
	{ head: "publish p50", pick: (r) => pct(r.io.writeMs, 0.5) },
	{ head: "publish max", pick: (r) => (r.io.writeMs.length ? Math.max(...r.io.writeMs) : 0) },
	{ head: "read MB", pick: (r) => r.io.readBytes / 1048576 },
	{ head: "write MB", pick: (r) => r.io.writeBytes / 1048576 },
];

function report(rounds: RoundResult[]): void {
	console.log(
		`\n=== ${rounds[0].label} (${rounds.length} rounds, burst=${BURST_SIZE}, tasks=${TASK_COUNT}, ` +
		`file=${(rounds[0].fileBytes / 1048576).toFixed(2)} MB) ===`,
	);
	const cell = (v: string, head: string) => v.padStart(Math.max(head.length, 7));
	console.log(["round", ...COLUMNS.map((c) => c.head.padStart(Math.max(c.head.length, 7)))].join(" | "));
	for (const [i, r] of rounds.entries()) {
		console.log([String(i + 1).padStart(5), ...COLUMNS.map((c) => cell(fmt(c.pick(r)), c.head))].join(" | "));
	}
	const avg = (pick: (r: RoundResult) => number) => rounds.reduce((a, r) => a + pick(r), 0) / rounds.length;
	console.log(["  avg", ...COLUMNS.map((c) => cell(fmt(avg(c.pick)), c.head))].join(" | "));
}

// ---- correctness + timing ----

const sequential: RoundResult[] = [];
for (let r = 0; r < ROUNDS; r++) sequential.push(await runRound("sequential burst (one task, ordering)", sequentialBurst));
report(sequential);

{
	const target = tasks[Math.floor(tasks.length / 2)];
	const persisted = await data.getTask(project, target.id);
	const expected = `${target.overview}${Array.from({ length: BURST_SIZE }, (_, i) => `|${i + 1}`).join("")}`;
	const ok = persisted.overview === expected;
	console.log(`ordering: ${ok ? "OK" : "FAIL"} — ${BURST_SIZE} mutations, persisted tail ${JSON.stringify(String(persisted.overview).slice(-30))}`);
	if (!ok) process.exitCode = 1;
}

const concurrent: RoundResult[] = [];
for (let r = 0; r < ROUNDS; r++) concurrent.push(await runRound(`concurrent burst (${BURST_SIZE} tasks / ${BURST_SPREAD_MS} ms)`, concurrentBurst));
report(concurrent);

{
	const all = await data.loadTasks(project);
	const byId = new Map(all.map((t) => [t.id, t]));
	const missing: number[] = [];
	for (let i = 0; i < BURST_SIZE; i++) {
		if (byId.get(tasks[burstTargetIndex(i)].id)?.overview !== `burst-${i}`) missing.push(i);
	}
	console.log(`lossless: ${missing.length === 0 ? "OK" : `FAIL — lost ${missing.join(",")}`} (${BURST_SIZE} concurrent mutations)`);
	if (missing.length) process.exitCode = 1;
	console.log(`store integrity: ${all.length} tasks persisted (expected ${TASK_COUNT})`);
	if (all.length !== TASK_COUNT) process.exitCode = 1;
}

console.log(
	"\nScope: only redundant whole-file reads were removed. Every mutation still parses the store, stringifies it, " +
	"and publishes it (writeFile + rename, no fsync), and measured main-loop blocking is unchanged. " +
	"Builds are compared by running this file against each separately, never side by side.",
);

rmSync(home, { recursive: true, force: true });
