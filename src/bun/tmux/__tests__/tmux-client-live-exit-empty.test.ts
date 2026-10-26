/**
 * Live tmux: a server started the launchd way (`tmux -D`, exit-empty off) must
 * wait for its first session, then still exit after the last one closes —
 * the `session-created` hook in the dev3 config restores that. Slow e2e,
 * excluded from the fast suite by the `tmux-client-live*` pattern.
 */
import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { activeTmuxConfigPath } from "../config";

function tmuxOnPath(): boolean {
	try {
		return /^tmux \d/.test(execFileSync("tmux", ["-V"], { encoding: "utf-8" }));
	} catch {
		return false;
	}
}

const SOCKET = `dev3-live-exit-empty-${process.pid}`;

function serverAnswers(): boolean {
	try {
		execFileSync("tmux", ["-L", SOCKET, "display-message", "-p", ""], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

let server: ChildProcess | null = null;

describe.skipIf(!tmuxOnPath())("foreground (-D) tmux server with the dev3 config", () => {
	afterAll(() => {
		try {
			execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
		} catch { /* already gone */ }
		server?.kill();
	});

	it("waits for its first session and exits after the last one closes", async () => {
		server = spawn("tmux", ["-D", "-L", SOCKET, "-f", activeTmuxConfigPath()], { stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => server!.on("exit", (code) => resolve(code)));
		let exitCode: number | null | undefined;
		void exited.then((code) => { exitCode = code; });

		expect(await until(serverAnswers, 5_000)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(exitCode).toBeUndefined();

		execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "only", "sleep 0.3"]);
		expect(await until(() => exitCode !== undefined, 5_000)).toBe(true);
		expect(exitCode).toBe(0);
	}, 15_000);
});
