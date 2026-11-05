import { parentPort, workerData } from "node:worker_threads";
import { realWorktreeScanDeps } from "../../cli/commands/doctor-worktrees";
import { compressAllDiffSnapshots } from "../diff-snapshots";
import { runWorktreeCleanup } from "../worktree-cleanup-job";

// The scan is all spawnSync (`du`, `git`) and takes minutes on a large tree; here it
// blocks only this thread. Bundled to dist/workers by scripts/build-cli.ts.
try {
	parentPort?.postMessage({ ok: true, result: runWorktreeCleanup(realWorktreeScanDeps(workerData.dev3Home), {
		afterPrune: (root) => compressAllDiffSnapshots(root),
	}) });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: String(error) });
}
