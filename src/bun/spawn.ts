/**
 * Wrappers around Bun.spawn / Bun.spawnSync that always inject process.env.
 *
 * macOS .app bundles inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 * We resolve the user's full PATH at startup (shell-env.ts → index.ts) and
 * patch process.env.PATH, but Bun.spawn without an explicit `env` option
 * may not pick up the change.
 *
 * These wrappers ensure every child process sees the full user PATH
 * (homebrew, nvm, etc.) by always merging process.env into the env option.
 *
 * They also default the child `cwd` to DEV3_HOME when the caller passes none.
 * The main process keeps its OWN cwd inside the .app bundle: electrobun resolves
 * native resources and the `views://` protocol relative to process.cwd(), so
 * chdir-ing the process away from the bundle blanks the desktop window with
 * "Resource not found". But a brew upgrade / in-app update can delete the bundle
 * dir from under a running instance, after which any child that inherits our
 * bundle cwd dies with ENOENT (posix_spawn resolves the child cwd from ours).
 * Pinning cwd-less children to DEV3_HOME — which lives as long as our data does —
 * sidesteps that without ever moving the process. See decision 109.
 *
 * RULE: Never use Bun.spawn / Bun.spawnSync directly — always use these.
 */

import { registerCurrentPreparationSpawn, unregisterPreparationSpawn } from "./preparation-runtime";
import { DEV3_HOME } from "./paths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDefaults(opts?: any) {
	return {
		...opts,
		cwd: opts?.cwd ?? DEV3_HOME,
		env: { ...process.env, ...(opts?.env ?? {}) },
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawn(cmd: string[], opts?: any) {
	const proc = Bun.spawn(cmd, withDefaults(opts));
	const ctx = registerCurrentPreparationSpawn(proc.pid, cmd);
	if (ctx && proc.pid) {
		proc.exited.finally(() => {
			unregisterPreparationSpawn(ctx.taskId, proc.pid);
		});
	}
	return proc;
}

// A synchronous spawn blocks the event loop for its full duration — under
// system load a normally-instant fork can take hundreds of ms. Anything above
// this threshold is logged so loop stalls can be attributed from the field
// instead of guessed at. (Lazy logger import: logger has no dependency on this
// module today, but a static import would make any future logger→spawn use a
// cycle, and spawnSync must never fail because logging did.)
const SLOW_SPAWN_SYNC_MS = 250;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawnSync(cmd: string[], opts?: any) {
	const startedAt = Date.now();
	const result = Bun.spawnSync(cmd, withDefaults(opts));
	const elapsedMs = Date.now() - startedAt;
	if (elapsedMs >= SLOW_SPAWN_SYNC_MS) {
		import("./logger")
			.then(({ createLogger }) => {
				createLogger("spawn").warn("Slow spawnSync blocked the event loop", { cmd: cmd.slice(0, 4).join(" "), elapsedMs });
			})
			.catch(() => {});
	}
	return result;
}
