import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { executeHandoffJob, type HandoffJob, type HandoffJobResult } from "./conversation-handoff-job";
import { createLogger } from "./logger";

const log = createLogger("handoff");

/**
 * Runs handoff jobs off the host thread. The host serves every RPC and the PTY
 * WebSocket from one event loop, so parsing a transcript of hundreds of MB there
 * froze the whole app. See decisions/2026/09/25/parse-handoff-transcripts-off-the-host-thread.md.
 */

let workerPath: string | null = null;
let warnedMissing = false;

/** Point the runner at the bundled worker; unset (tests, a build without it) runs inline. */
export function configureHandoffWorker(path: string | null): void {
	workerPath = path;
}

export interface RunHandoffJobOptions {
	timeoutMs: number;
}

function runInWorker(path: string, job: HandoffJob, { timeoutMs }: RunHandoffJobOptions): Promise<HandoffJobResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(path, { workerData: job });
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate().catch(() => {});
			settle();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`handoff ${job.kind} timed out after ${timeoutMs} ms`))),
			timeoutMs,
		);
		worker.on("message", (message: { ok: boolean; result?: HandoffJobResult; error?: string }) => {
			finish(() => (message.ok && message.result ? resolve(message.result) : reject(new Error(message.error ?? "handoff worker failed"))));
		});
		worker.on("error", (error) => finish(() => reject(error)));
		worker.on("exit", (code) => finish(() => reject(new Error(`handoff worker exited with code ${code}`))));
	});
}

export async function runHandoffJob(job: HandoffJob, options: RunHandoffJobOptions): Promise<HandoffJobResult> {
	if (workerPath && existsSync(workerPath)) return runInWorker(workerPath, job, options);
	if (workerPath && !warnedMissing) {
		warnedMissing = true;
		log.warn("Handoff worker missing; parsing on the host thread", { kind: job.kind });
	}
	return executeHandoffJob(job);
}
