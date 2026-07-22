import {
	FakeTerminalRegistry,
	type FakeTerminalDiagnostics,
} from "./fake-terminal";

export interface FakeTerminalStressOptions {
	paneCount?: number;
	durationMs?: number;
	outputIntervalMs?: number;
	resizeIntervalMs?: number;
}

export interface FakeTerminalStressResult {
	parameters: Required<FakeTerminalStressOptions>;
	elapsedMs: number;
	aborted: boolean;
	cpu: { userMs: number; systemMs: number; totalMs: number } | null;
	memory: { beforeBytes: number | null; peakBytes: number | null; afterBytes: number | null; deltaBytes: number | null };
	events: { output: number; input: number; resize: number; checksum: number };
	beforeCleanup: FakeTerminalDiagnostics;
	afterCleanup: FakeTerminalDiagnostics;
	cleanupPassed: boolean;
}

interface BrowserPerformanceMemory extends Performance {
	memory?: { usedJSHeapSize?: number };
}

function readHeapBytes(): number | null {
	if (typeof process !== "undefined" && typeof process.memoryUsage === "function") {
		return process.memoryUsage().heapUsed;
	}
	if (typeof performance !== "undefined") {
		return (performance as BrowserPerformanceMemory).memory?.usedJSHeapSize ?? null;
	}
	return null;
}

function nowMs(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

function waitForDuration(durationMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (aborted: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const timer = setTimeout(() => finish(false), durationMs);
		const onAbort = () => finish(true);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function runFakeTerminalStress(
	options: FakeTerminalStressOptions = {},
	signal?: AbortSignal,
): Promise<FakeTerminalStressResult> {
	const parameters: Required<FakeTerminalStressOptions> = {
		paneCount: Math.max(1, Math.floor(options.paneCount ?? 6)),
		durationMs: Math.max(1, Math.floor(options.durationMs ?? 1_500)),
		outputIntervalMs: Math.max(1, Math.floor(options.outputIntervalMs ?? 12)),
		resizeIntervalMs: Math.max(1, Math.floor(options.resizeIntervalMs ?? 20)),
	};
	const registry = new FakeTerminalRegistry({ outputIntervalMs: parameters.outputIntervalMs });
	const paneIds = Array.from({ length: parameters.paneCount }, (_, index) => `pane-${index + 1}`);
	registry.reconcile(paneIds);
	let outputEvents = 0;
	let inputEvents = 0;
	let resizeEvents = 0;
	let checksum = 0;
	const unsubscribers: Array<() => void> = [];
	for (const paneId of paneIds) {
		const session = registry.get(paneId)!;
		unsubscribers.push(session.subscribeOutput((event) => {
			outputEvents += 1;
			checksum = (checksum + event.line.length * 31 + event.sequence) >>> 0;
		}));
		unsubscribers.push(session.subscribeInput(() => {
			inputEvents += 1;
		}));
		unsubscribers.push(session.subscribeResize(() => {
			resizeEvents += 1;
		}));
	}

	const beforeBytes = readHeapBytes();
	let peakBytes = beforeBytes;
	let resizeTick = 0;
	const resizeTimer = setInterval(() => {
		resizeTick += 1;
		for (let index = 0; index < paneIds.length; index++) {
			const session = registry.get(paneIds[index]);
			if (!session) continue;
			session.resize(72 + ((resizeTick + index) % 48), 18 + ((resizeTick * 2 + index) % 20));
			if (resizeTick % 4 === 0) session.writeInput(`stress-${resizeTick}-${index + 1}`);
		}
		const heap = readHeapBytes();
		if (heap !== null && (peakBytes === null || heap > peakBytes)) peakBytes = heap;
	}, parameters.resizeIntervalMs);

	const cpuStart = typeof process !== "undefined" && typeof process.cpuUsage === "function"
		? process.cpuUsage()
		: null;
	const startedAt = nowMs();
	const aborted = await waitForDuration(parameters.durationMs, signal);
	const elapsedMs = nowMs() - startedAt;
	const cpuRaw = cpuStart && typeof process !== "undefined" && typeof process.cpuUsage === "function"
		? process.cpuUsage(cpuStart)
		: null;
	clearInterval(resizeTimer);

	const beforeCleanup = registry.diagnostics();
	for (const unsubscribe of unsubscribers) unsubscribe();
	registry.dispose();
	const afterCleanup = registry.diagnostics();
	const afterBytes = readHeapBytes();
	const cleanupPassed =
		afterCleanup.activeSessions === 0 &&
		afterCleanup.runningTimers === 0 &&
		afterCleanup.outputSubscriptions === 0 &&
		afterCleanup.inputSubscriptions === 0 &&
		afterCleanup.resizeSubscriptions === 0;

	return {
		parameters,
		elapsedMs,
		aborted,
		cpu: cpuRaw ? {
			userMs: cpuRaw.user / 1_000,
			systemMs: cpuRaw.system / 1_000,
			totalMs: (cpuRaw.user + cpuRaw.system) / 1_000,
		} : null,
		memory: {
			beforeBytes,
			peakBytes,
			afterBytes,
			deltaBytes: beforeBytes === null || afterBytes === null ? null : afterBytes - beforeBytes,
		},
		events: { output: outputEvents, input: inputEvents, resize: resizeEvents, checksum },
		beforeCleanup,
		afterCleanup,
		cleanupPassed,
	};
}
