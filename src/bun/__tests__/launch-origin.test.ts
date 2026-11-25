import { describe, it, expect } from "vitest";
import { dropTaskEnvFromOsLaunch, isLaunchedByLaunchServices, readParentPid } from "../launch-origin";

const LAUNCHER_PID = 89736;

/** A process table: pid -> parent pid. */
function table(rows: Record<number, number>): (pid: number) => number | null {
	return (pid) => rows[pid] ?? null;
}

function paneEnv(): Record<string, string | undefined> {
	return {
		PATH: "/usr/bin",
		DEV3_TASK_ID: "363014cf-ab89-4e00-a937-8ed54cacb74b",
		DEV3_TASK_SEQ: "78-1",
		DEV3_TASK_TITLE: "Sync local with upstream and reinstall",
		DEV3_WORKTREE_PATH: "/tmp/wt",
		DEV3_BRANCH_NAME: "",
		DEV3_PROJECT_PATH: "/tmp/project",
	};
}

describe("isLaunchedByLaunchServices", () => {
	it("is true on macOS when the launcher is a direct child of launchd", () => {
		expect(isLaunchedByLaunchServices({ platform: "darwin", ppid: LAUNCHER_PID, parentOf: table({ [LAUNCHER_PID]: 1 }) })).toBe(true);
	});

	it("is false under another process, with an unreadable grandparent, for an orphan, and on every other OS", () => {
		// electrobun dev in a dev-server pane: the launcher runs under another process.
		expect(isLaunchedByLaunchServices({ platform: "darwin", ppid: LAUNCHER_PID, parentOf: table({ [LAUNCHER_PID]: 4242 }) }), "nested").toBe(false);
		expect(isLaunchedByLaunchServices({ platform: "darwin", ppid: LAUNCHER_PID, parentOf: () => null }), "unreadable").toBe(false);
		// An orphan (ppid 1): its own parent is not a launcher.
		expect(isLaunchedByLaunchServices({ platform: "darwin", ppid: 1, parentOf: table({ 1: 0 }) }), "orphan").toBe(false);
		for (const platform of ["linux", "win32"] as const) {
			expect(isLaunchedByLaunchServices({ platform, ppid: LAUNCHER_PID, parentOf: table({ [LAUNCHER_PID]: 1 }) }), platform).toBe(false);
		}
	});
});

describe("dropTaskEnvFromOsLaunch", () => {
	const osLaunch = { platform: "darwin" as const, ppid: LAUNCHER_PID, parentOf: table({ [LAUNCHER_PID]: 1 }) };

	it("drops the task-scoped keys from an app `open`ed inside a dev3 pane, so it registers as the primary", () => {
		const env: Record<string, string | undefined> = { ...paneEnv(), DEV3_DEV_SERVER: "default", DEV3_WORKTREE_ROOT: "/tmp/wt" };
		const removed = dropTaskEnvFromOsLaunch(env, osLaunch);

		expect(removed.sort()).toEqual(
			["DEV3_BRANCH_NAME", "DEV3_DEV_SERVER", "DEV3_TASK_ID", "DEV3_TASK_SEQ", "DEV3_TASK_TITLE", "DEV3_WORKTREE_PATH", "DEV3_WORKTREE_ROOT"],
		);
		expect(env.DEV3_TASK_ID).toBeUndefined();
		// The project path names no task, and the rest of the env is untouched.
		expect(env.DEV3_PROJECT_PATH).toBe("/tmp/project");
		expect(env.PATH).toBe("/usr/bin");
	});

	it("keeps a dev-server guest's task env", () => {
		const env = paneEnv();
		const removed = dropTaskEnvFromOsLaunch(env, { ...osLaunch, parentOf: table({ [LAUNCHER_PID]: 4242 }) });

		expect(removed).toEqual([]);
		expect(env.DEV3_TASK_ID).toBe("363014cf-ab89-4e00-a937-8ed54cacb74b");
	});

	it("changes nothing without DEV3_TASK_ID, and never asks for the process table", () => {
		const env: Record<string, string | undefined> = { PATH: "/usr/bin", DEV3_DEV_SERVER: "default" };
		const removed = dropTaskEnvFromOsLaunch(env, {
			...osLaunch,
			parentOf: () => {
				throw new Error("must not probe");
			},
		});

		expect(removed).toEqual([]);
		expect(env.DEV3_DEV_SERVER).toBe("default");
	});
});

describe("readParentPid", () => {
	const ps = (exitCode: number | null, stdout: string) => () => ({ exitCode, stdout: Buffer.from(stdout) });

	it("parses the parent pid that `ps -o ppid=` prints, padding included", () => {
		let cmd: string[] = [];
		const run = (c: string[]) => {
			cmd = c;
			return { exitCode: 0, stdout: Buffer.from("    1\n") };
		};
		expect(readParentPid(LAUNCHER_PID, run)).toBe(1);
		expect(cmd).toEqual(["ps", "-o", "ppid=", "-p", String(LAUNCHER_PID)]);
	});

	it("returns null for a pid that does not exist, unparsable output, or a spawn that throws", () => {
		// ps exits 1 and prints nothing for a missing pid.
		expect(readParentPid(LAUNCHER_PID, ps(1, ""))).toBeNull();
		expect(readParentPid(LAUNCHER_PID, ps(0, "\n"))).toBeNull();
		expect(readParentPid(LAUNCHER_PID, () => {
			throw new Error("ENOENT");
		})).toBeNull();
	});
});
