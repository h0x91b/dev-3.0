/**
 * Can anything name the code that blocked the main loop? (seq 1407 attribution spike)
 *
 * The app's main process goes fully unresponsive for seconds at a time, and the
 * existing stall detector only reports THAT a tick was late — never what was on the
 * stack. This harness pins the one mechanism that turned out to work, plus every
 * limit it ships with, so a Bun upgrade that changes any of them fails here instead
 * of silently invalidating the design.
 *
 * Deliberately a plain bun script, not a vitest file: it starts a process-wide
 * sampling profiler that cannot be stopped again, so it must not share a worker
 * with unrelated tests.
 *
 * Run: bun run test:stall-attribution-e2e
 */

import * as jsc from "bun:jsc";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SampleFrame {
	name: string;
	sourceURL: string;
	line: number;
	column: number;
	category: string;
	sourceID: number;
	location: string;
	flags: number;
}
interface SampleDump {
	interval: number;
	traces: { timestamp: number; frames: SampleFrame[] }[];
}

/**
 * `samplingProfilerStackTraces` exists at runtime but is absent from `@types/bun`
 * 1.3.14, so it has to be reached through the namespace. That is itself a limit worth
 * knowing: product code would need the same local declaration, and a Bun release that
 * adds or renames the type breaks here rather than at a call site.
 */
const startSamplingProfiler = jsc.startSamplingProfiler as (interval?: number) => void;
const samplingProfilerStackTraces = (jsc as unknown as { samplingProfilerStackTraces: () => unknown })
	.samplingProfilerStackTraces;

let failures = 0;
function check(ok: boolean, what: string): void {
	console.log(`  ${ok ? "ok  " : "FAIL"} - ${what}`);
	if (!ok) failures++;
}

/**
 * The profiler hands back either a JSON string or the object; normalise once.
 *
 * A never-armed profiler THROWS here rather than returning nothing, and letting that
 * escape would abort the run before a single check printed — the harness would report
 * "crashed" where it should report which property broke. So an unusable profiler
 * becomes an empty dump and every needle check below fails on its own terms.
 */
function drain(): SampleDump {
	try {
		const raw = samplingProfilerStackTraces();
		return (typeof raw === "string" ? JSON.parse(raw) : raw) as SampleDump;
	} catch (err) {
		console.log(`  (profiler unusable: ${String(err)})`);
		return { interval: 0, traces: [] };
	}
}

function frameNames(dump: SampleDump): Set<string> {
	const names = new Set<string>();
	for (const trace of dump.traces) for (const frame of trace.frames) names.add(frame.name);
	return names;
}

/** A JS-bound block: the loop is busy inside interpreted/JIT-ed JavaScript. */
function dev3JsBoundNeedle(ms: number): number {
	let acc = 0;
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) acc += Math.sqrt(acc + 1);
	return acc;
}

/**
 * A syscall-bound block: the loop is inside a synchronous write, which is the shape
 * the real suspect has (`appendFileSync` in the logger). A profiler that only sees
 * JS would miss this one, so it is asserted separately.
 */
function dev3SyscallBoundNeedle(path: string, line: string, times: number): void {
	for (let i = 0; i < times; i++) appendFileSync(path, line);
}

const BLOCK_MS = 3000;
/**
 * The rate JSC actually samples at, measured, not assumed. The band is wide because
 * it is a machine-speed observation — the point is to notice an ORDER-of-magnitude
 * change, since drain cost is linear in this number.
 */
const MIN_SAMPLES_PER_SEC = 300;
const MAX_SAMPLES_PER_SEC = 3000;

const root = mkdtempSync(join(tmpdir(), "dev3-stall-attr-"));
const logPath = join(root, "day.log");
const LOG_LINE = `${"2026-08-04 12:00:00.000 INFO  [00000:rpc] → checkDevServer "}${JSON.stringify({ taskId: "0".repeat(36) })}\n`;

try {
	console.log("# the mechanism: bun:jsc sampling profiler\n");

	startSamplingProfiler();
	drain(); // discard whatever the module load produced

	// ── 1. does anything survive a fully blocked loop? ────────────────────────
	dev3JsBoundNeedle(BLOCK_MS);
	const jsDump = drain();
	const jsNames = frameNames(jsDump);
	const perSec = jsDump.traces.length / (BLOCK_MS / 1000);
	console.log(`  ${jsDump.traces.length} samples over ${BLOCK_MS} ms => ${perSec.toFixed(0)}/s at interval ${jsDump.interval}`);
	check(jsNames.has("dev3JsBoundNeedle"), "a JS-bound block is named in the profile");
	check(
		perSec >= MIN_SAMPLES_PER_SEC && perSec <= MAX_SAMPLES_PER_SEC,
		`the sample rate stayed in the measured band (${MIN_SAMPLES_PER_SEC}-${MAX_SAMPLES_PER_SEC}/s)`,
	);

	// ── 2. the buffer accumulates, it is NOT a bounded ring ───────────────────
	// This is the cost driver: one drain after an N-second stall materialises the
	// WHOLE stall as a JS object graph, so cost is linear in stall length.
	check(
		jsDump.traces.length > MIN_SAMPLES_PER_SEC * (BLOCK_MS / 1000),
		"samples accumulate until drained rather than being capped to a recent window",
	);
	check(drain().traces.length < jsDump.traces.length, "a drain empties the buffer instead of re-reporting");

	// ── 3. a blocking SYSCALL is attributed too ───────────────────────────────
	writeFileSync(logPath, "");
	const pad = `${"y".repeat(1_048_576)}\n`;
	while (statSync(logPath).size < 200 * 1e6) appendFileSync(logPath, pad);
	drain();
	const syscallStartedAt = performance.now();
	dev3SyscallBoundNeedle(logPath, LOG_LINE, 4000);
	const syscallMs = performance.now() - syscallStartedAt;
	const syscallNames = frameNames(drain());
	console.log(`  4000 appends to a ${(statSync(logPath).size / 1e6).toFixed(0)} MB file took ${Math.round(syscallMs)} ms`);
	check(syscallNames.has("dev3SyscallBoundNeedle"), "a syscall-bound block is named in the profile");
	check(syscallNames.has("appendFileSync"), "the blocking call itself is named, not just its caller");

	// ── 4. the limits this design rests on ────────────────────────────────────
	// Bun 1.3.14 ignores an interval argument and offers no stop, so the sample rate
	// is fixed and the profiler is a launch-time decision, not a runtime toggle.
	// If a future Bun changes either, the design gains a knob — and this goes red.
	check(
		typeof jsc.startSamplingProfiler === "function" && typeof samplingProfilerStackTraces === "function",
		"bun:jsc still exposes startSamplingProfiler",
	);
	check(
		!("stopSamplingProfiler" in jsc),
		"bun:jsc still has NO stop — profiling cannot be turned off once armed",
	);
	drain();
	startSamplingProfiler(0.05); // a 50 ms interval, if it were honoured
	dev3JsBoundNeedle(1000);
	const coarse = drain();
	check(
		coarse.interval === jsDump.interval && coarse.traces.length / 1 > MIN_SAMPLES_PER_SEC,
		"an interval argument is still ignored — volume cannot be traded for resolution",
	);

	// ── 5. privacy: what a profile can and cannot leak ────────────────────────
	// Frames carry code identity only. No argument values, no string contents, no
	// user data — but sourceURL IS an absolute path, so paths are the only thing a
	// shipped profile would have to mask.
	const allowed = new Set(["name", "sourceURL", "line", "column", "category", "sourceID", "location", "flags"]);
	const unexpected = new Set<string>();
	let framesInspected = 0;
	for (const trace of coarse.traces) {
		for (const frame of trace.frames) {
			framesInspected++;
			for (const key of Object.keys(frame)) if (!allowed.has(key)) unexpected.add(key);
		}
	}
	// "no unexpected fields" is trivially true of an empty profile, so the count is
	// asserted first — otherwise a broken profiler would read as a privacy pass.
	check(framesInspected > 0, `there were frames to inspect at all (${framesInspected})`);
	check(unexpected.size === 0, `a frame carries only code identity — no new fields (saw extra: ${[...unexpected].join(", ") || "none"})`);
	check(
		coarse.traces.some((t) => t.frames.some((f) => f.sourceURL.startsWith("/"))),
		"sourceURL is an absolute path, so any shipped profile must mask paths",
	);

	// ── 6. the profiler is VM-LOCAL, which is what kills the design ───────────
	// The obvious escape from the drain cost is a Worker draining on a cadence while
	// the main thread is blocked. The thread part works — a Worker keeps perfect
	// 250 ms timing across a 20 s main-thread block — but the buffer is per-VM, so a
	// Worker can neither read the main VM's samples nor arm it. Pinned here so the
	// experiment is not repeated, and so a Bun release that makes it process-global
	// shows up as a failure worth acting on.
	const workerFile = join(root, "drain-probe.ts");
	writeFileSync(
		workerFile,
		`import * as jsc from "bun:jsc";\n` +
			`const drain = (jsc as any).samplingProfilerStackTraces;\n` +
			`let verdict = "no-answer";\n` +
			`try { drain(); verdict = "read-main-buffer"; } catch (err) { verdict = "threw:" + String(err); }\n` +
			`(self as any).postMessage({ verdict });\n`,
	);
	const workerVerdict = await new Promise<string>((resolve) => {
		const probe = new Worker(new URL(`file://${workerFile}`).href);
		const timer = setTimeout(() => {
			probe.terminate();
			resolve("timeout");
		}, 10_000);
		probe.addEventListener("message", (event) => {
			clearTimeout(timer);
			probe.terminate();
			resolve(String((event as MessageEvent).data?.verdict ?? "no-verdict"));
		});
	});
	console.log(`  worker verdict: ${workerVerdict}`);
	check(
		workerVerdict.startsWith("threw:") && workerVerdict.includes("never started"),
		"a Worker cannot drain the MAIN VM's buffer — the profiler is VM-local",
	);
	check(drain().traces.length >= 0, "the main VM's own profiler is still armed and readable after the probe");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
