/**
 * Who started this desktop process, and what that says about the task env it
 * carries.
 *
 * `open` from a terminal hands the caller's environment to the launched app on
 * macOS. Started from a dev3 pane (an agent running the install recipe's `open`
 * step), the app then holds that pane's DEV3_TASK_ID and reads itself as a guest
 * of that task: its socket sidecar records `hostTaskId`, CLI discovery ranks it
 * with the guests, and a dev-server instance started later wins on mtime. A
 * `dev3 task move` then opens its dialog in the dev window and dies with it.
 *
 * A LaunchServices launch is a child of launchd (pid 1) through the bundle's
 * launcher, so the app process's grandparent is 1. A real guest (a dev build the
 * devScript boots inside the dev-server session) runs under the `electrobun dev`
 * process instead. See decisions/2026/11/17/os-launched-app-is-never-a-guest.md.
 */

import { TASK_SCOPED_ENV_KEYS } from "./rpc-handlers/shared-pure";
import { spawnSync } from "./spawn";

/** Task env a dev3 pane gives its children, which an OS-launched app must not keep. */
export const INHERITED_TASK_ENV_KEYS: readonly string[] = [...TASK_SCOPED_ENV_KEYS, "DEV3_DEV_SERVER", "DEV3_WORKTREE_ROOT"];

export interface LaunchOriginInput {
	platform: NodeJS.Platform;
	/** This process's parent (on macOS, the bundle's launcher). */
	ppid: number;
	/** The parent pid of `pid`, or null when it cannot be read. */
	parentOf: (pid: number) => number | null;
}

/**
 * True when macOS LaunchServices started this app (Dock, Finder, `open`): the
 * launcher that spawned it is a direct child of launchd. Another OS, an unknown
 * grandparent, or a launcher already orphaned (ppid 1) reads as false, so the
 * process keeps its env and today's guest behavior.
 */
export function isLaunchedByLaunchServices(input: LaunchOriginInput): boolean {
	if (input.platform !== "darwin") return false;
	if (input.ppid <= 1) return false;
	return input.parentOf(input.ppid) === 1;
}

/**
 * Delete the inherited task env from `env` when the OS launched this app. Returns
 * the keys it removed (empty when it changed nothing). Must run before anything
 * reads DEV3_TASK_ID: the socket sidecar, launch handoff, the self-hosted
 * dev-server check and the dev3 self-shim all do.
 */
export function dropTaskEnvFromOsLaunch(env: Record<string, string | undefined>, input: LaunchOriginInput): string[] {
	if (!env.DEV3_TASK_ID) return [];
	if (!isLaunchedByLaunchServices(input)) return [];
	const removed: string[] = [];
	for (const key of INHERITED_TASK_ENV_KEYS) {
		if (env[key] === undefined) continue;
		delete env[key];
		removed.push(key);
	}
	return removed;
}

type SpawnSyncFn = (cmd: string[], opts?: { stdout?: "pipe"; stderr?: "ignore" }) => { exitCode: number | null; stdout: { toString(): string } };

/** `ps -o ppid= -p <pid>`. `ps` works from the hardened-runtime bundle (see port-scanner.ts). */
export function readParentPid(pid: number, run: SpawnSyncFn = spawnSync): number | null {
	try {
		const result = run(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return null;
		const parsed = parseInt(result.stdout.toString().trim(), 10);
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}
