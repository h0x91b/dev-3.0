import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { Readable } from "node:stream";
import { runBounded } from "../bounded-spawn";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
	for (let waited = 0; waited < withinMs; waited += 50) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !alive(pid);
}

/**
 * A real child in the shape runBounded consumes. Vitest runs under Node with a
 * stubbed `Bun`, so the process comes from node:child_process.
 */
function spawnReal(cmd: string[], detached: boolean) {
	const child = spawnChild(cmd[0], cmd.slice(1), { detached, stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 143)));
	return {
		pid: child.pid ?? 0,
		kill: (signal?: NodeJS.Signals) => child.kill(signal),
		exited,
		stdout: Readable.toWeb(child.stdout!),
		stderr: Readable.toWeb(child.stderr!),
	} as unknown as Parameters<typeof runBounded>[0];
}

/**
 * A hung parent with a forked helper that ignores SIGTERM — the shape of a stuck
 * `lsof`, whose helper child outlives a TERM to its parent. Real processes.
 */
async function runHungForker(processGroup: boolean): Promise<{ helper: number; stopped: boolean }> {
	const dir = mkdtempSync(join(tmpdir(), "dev3-bounded-group-"));
	const pidFile = join(dir, "helper.pid");
	try {
		const proc = spawnReal(["sh", "-c", `(trap '' TERM; sleep 30) & echo $! > '${pidFile}'; sleep 30`], processGroup);
		for (let i = 0; i < 100 && !readPid(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		const helper = readPid(pidFile);
		expect(helper).toBeGreaterThan(0);
		const outcome = await runBounded(proc, { timeoutMs: 200, processGroup });
		return { helper, stopped: outcome.kind === "stopped" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function readPid(file: string): number {
	try {
		return Number.parseInt(readFileSync(file, "utf8"), 10) || 0;
	} catch {
		return 0;
	}
}

describe.skipIf(process.platform === "win32")("runBounded with processGroup", () => {
	it("stops a hung command AND its TERM-ignoring forked helper", async () => {
		const { helper, stopped } = await runHungForker(true);
		expect(stopped).toBe(true);
		expect(await gone(helper, 2_000)).toBe(true);
	});

	it("without the group, the helper survives the stop (why lsof scans need it)", async () => {
		const { helper, stopped } = await runHungForker(false);
		try {
			expect(stopped).toBe(true);
			expect(await gone(helper, 500)).toBe(false);
		} finally {
			process.kill(helper, "SIGKILL");
		}
	});
});
