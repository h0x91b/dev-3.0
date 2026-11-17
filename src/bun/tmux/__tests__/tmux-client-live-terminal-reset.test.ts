/**
 * Live tmux: an agent killed with SIGKILL must not leave the pane in the alternate screen,
 * mouse or extended-key mode, or a raw tty. Private socket; slow e2e (`tmux-client-live*`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCmdScript } from "../../rpc-handlers/shared-pure";

function tmuxOnPath(): boolean {
	try {
		return /^tmux \d/.test(execFileSync("tmux", ["-V"], { encoding: "utf-8" }));
	} catch {
		return false;
	}
}

const runnable = process.platform !== "win32" && tmuxOnPath();
const SOCKET = `dev3-test-terminal-reset-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const dir = runnable ? mkdtempSync(join(tmpdir(), "dev3-terminal-reset-")) : "";

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8" }).trim();
}

const CLEAN_FLAGS = "0 0 0 1 VT10x";

const FAKE_AGENT = [
	"#!/bin/bash",
	"printf '\\033[?1049h\\033[?1003h\\033[?1006h\\033[?2004h\\033[?1004h\\033[>1u\\033[>4;2m\\033[?25l'",
	"stty raw -echo",
	"sleep 0.5",
	"kill -9 $$",
	"",
].join("\n");

describe.skipIf(!runnable)("run wrapper after a killed agent", () => {
	afterAll(() => {
		try {
			tmux("kill-server");
		} catch { /* already gone */ }
		rmSync(dir, { recursive: true, force: true });
	});

	it("leaves the pane out of the alternate screen with mouse, keys and cursor back to normal", async () => {
		const conf = join(dir, "tmux.conf");
		writeFileSync(
			conf,
			[
				"set -g extended-keys on",
				"set -g focus-events on",
				'set -as terminal-features "xterm*:extkeys"',
				"setw -g mouse on",
				"",
			].join("\n"),
		);
		const agent = join(dir, "agent.sh");
		writeFileSync(agent, FAKE_AGENT, { mode: 0o755 });
		const wrapper = join(dir, "run.sh");
		// `cat` as the hand-over shell: its name differs from the bash running the wrapper and the agent.
		writeFileSync(wrapper, buildCmdScript(`bash ${agent}`, undefined, { keepShell: true, shellPath: "/bin/cat" }));

		execFileSync("tmux", ["-L", SOCKET, "-f", conf, "new-session", "-d", "-x", "100", "-y", "30", `bash ${wrapper}`]);

		let command = "";
		for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
			command = tmux("display", "-p", "#{pane_current_command}");
			if (command === "cat") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(command).toBe("cat");

		const flags = () =>
			tmux("display", "-p", "#{alternate_on} #{mouse_all_flag} #{mouse_sgr_flag} #{cursor_flag} #{pane_key_mode}");
		let seen = flags();
		for (const deadline = Date.now() + 2_000; seen !== CLEAN_FLAGS && Date.now() < deadline;) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			seen = flags();
		}
		expect(seen).toBe(CLEAN_FLAGS);

		const tty = tmux("display", "-p", "#{pane_tty}");
		const settings = execFileSync("stty", process.platform === "darwin" ? ["-a", "-f", tty] : ["-F", tty, "-a"], {
			encoding: "utf-8",
		});
		expect(settings).toMatch(/(^|[\s;])icanon(?=[\s;]|$)/);
		expect(settings).toMatch(/(^|[\s;])echo(?=[\s;]|$)/);
	}, 15_000);
});
