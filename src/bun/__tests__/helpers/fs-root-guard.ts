/**
 * A `node:fs/promises` that refuses every path outside the roots a test armed it
 * with, and records the attempt. Used by suites that run real Codex store
 * discovery, so a store reached through inherited env (e.g. an agent shell's
 * CODEX_HOME) fails the test instead of being read.
 *
 *   const guard = vi.hoisted(() => ({ roots: null as string[] | null, violations: [] as string[] }));
 *   vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual(), guard));
 */
import { resolve } from "node:path";

export interface FsRootGuard {
	/** Null = disarmed (module setup may touch anything). */
	roots: string[] | null;
	violations: string[];
}

const PATH_ARGS: Record<string, number[]> = { rename: [0, 1], copyFile: [0, 1], cp: [0, 1], link: [0, 1], symlink: [1] };

function pathOf(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value instanceof URL && value.protocol === "file:") return value.pathname;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return null;
}

export function assertInsideRoots(guard: FsRootGuard, raw: string, op: string): void {
	if (!guard.roots) return;
	const path = resolve(raw);
	if (guard.roots.some((root) => path === root || path.startsWith(`${root}/`))) return;
	guard.violations.push(`${op} ${path}`);
	throw Object.assign(new Error(`fs-root-guard: ${op} outside fixture roots: ${path}`), { code: "EACCES" });
}

export function guardFsPromises<T extends Record<string, unknown>>(actual: T, guard: FsRootGuard): T {
	const wrapped: Record<string, unknown> = { ...actual };
	for (const [name, value] of Object.entries(actual)) {
		if (typeof value !== "function" || name === "constants") continue;
		const argIndexes = PATH_ARGS[name] ?? [0];
		wrapped[name] = (...args: unknown[]) => {
			for (const index of argIndexes) {
				const path = pathOf(args[index]);
				if (path !== null) assertInsideRoots(guard, path, name);
			}
			return (value as (...a: unknown[]) => unknown)(...args);
		};
	}
	wrapped.default = wrapped;
	return wrapped as T;
}
