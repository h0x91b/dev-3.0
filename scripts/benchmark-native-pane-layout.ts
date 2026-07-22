import { arch, cpus, platform, release } from "node:os";
import { runFakeTerminalStress } from "../src/mainview/labs/native-pane/stress";

const parameters = {
	paneCount: 6,
	durationMs: 5_000,
	outputIntervalMs: 8,
	resizeIntervalMs: 16,
} as const;

function collectHeap(): number {
	return process.memoryUsage().heapUsed;
}

await runFakeTerminalStress({ ...parameters, durationMs: 250 });
Bun.gc(true);
const retainedHeapBeforeBytes = collectHeap();
const result = await runFakeTerminalStress(parameters);
Bun.gc(true);
const retainedHeapAfterBytes = collectHeap();

const report = {
	capturedAt: new Date().toISOString(),
	environment: {
		runtime: `Bun ${Bun.version}`,
		platform: platform(),
		release: release(),
		arch: arch(),
		cpu: cpus()[0]?.model ?? "unknown",
	},
	parameters,
	measurements: {
		elapsedMs: Number(result.elapsedMs.toFixed(1)),
		cpu: result.cpu,
		memory: {
			...result.memory,
			retainedHeapBeforeBytes,
			retainedHeapAfterBytes,
			retainedHeapDeltaBytes: retainedHeapAfterBytes - retainedHeapBeforeBytes,
		},
		events: result.events,
	},
	cleanup: {
		before: result.beforeCleanup,
		after: result.afterCleanup,
		passed: result.cleanupPassed,
	},
};

console.log(JSON.stringify(report, null, 2));
if (!result.cleanupPassed) process.exitCode = 1;
