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
 * RULE: Never use Bun.spawn / Bun.spawnSync directly — always use these.
 */

import { registerCurrentPreparationSpawn, unregisterPreparationSpawn } from "./preparation-runtime";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawn(cmd: string[], opts?: any) {
	const proc = Bun.spawn(cmd, {
		...opts,
		env: { ...process.env, ...(opts?.env ?? {}) },
	});
	const ctx = registerCurrentPreparationSpawn(proc.pid, cmd);
	if (ctx && proc.pid) {
		proc.exited.finally(() => {
			unregisterPreparationSpawn(ctx.taskId, proc.pid);
		});
	}
	return proc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawnSync(cmd: string[], opts?: any) {
	return Bun.spawnSync(cmd, {
		...opts,
		env: { ...process.env, ...(opts?.env ?? {}) },
	});
}
