import { parentPort, workerData } from "node:worker_threads";
import { executeHandoffJob, type HandoffJob } from "../conversation-handoff-job";

// One job per worker: the parse can hold gigabytes, and exiting is the only way
// to hand all of it back. Bundled to dist/workers by scripts/build-cli.ts.
try {
	parentPort?.postMessage({ ok: true, result: executeHandoffJob(workerData as HandoffJob) });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: String(error) });
}
