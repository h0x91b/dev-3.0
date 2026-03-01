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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawn(cmd: string[], opts?: any) {
	return Bun.spawn(cmd, {
		...opts,
		env: { ...process.env, ...(opts?.env ?? {}) },
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spawnSync(cmd: string[], opts?: any) {
	return Bun.spawnSync(cmd, {
		...opts,
		env: { ...process.env, ...(opts?.env ?? {}) },
	});
}
