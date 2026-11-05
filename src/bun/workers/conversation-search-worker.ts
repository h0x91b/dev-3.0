import { parentPort, workerData } from "node:worker_threads";
import { searchProjectConversations } from "../conversation-search-project";

// One search per worker: synchronous reads over every transcript, which would
// freeze the host thread. Bundled to dist/workers by scripts/build-cli.ts.
try {
	parentPort?.postMessage({ ok: true, result: searchProjectConversations(workerData) });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: String(error) });
}
