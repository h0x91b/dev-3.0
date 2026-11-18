/**
 * Live tmux: an agent killed with SIGKILL must not leave the pane in the alternate screen,
 * mouse or extended-key mode, or a raw tty. Private socket; slow e2e (`tmux-client-live*`).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
const MODES = "\\033[?1003h\\033[?1006h\\033[?2004h\\033[?1004h\\033[>1u\\033[>4;2m\\033[?25l";

function fakeAgent(body: string, modes: string): string {
	return [
		"#!/bin/bash",
		`printf '${body}'`,
		`printf '${modes}'`,
		"stty raw -echo",
		"sleep 0.5",
		"kill -9 $$",
		"",
	].join("\n");
}

const MAIN_FOUR = "l1\\r\\nl2\\r\\nl3\\r\\nl4";

// The agent lines the pane must still show, in order, once the wrapper has run.
const SCENARIOS = [
	{
		name: "never entered the alternate screen",
		agent: fakeAgent(MAIN_FOUR, MODES),
		lines: ["l1", "l2", "l3", "l4"],
	},
	{
		name: "killed inside the alternate screen",
		agent: fakeAgent(`${MAIN_FOUR}\\033[?1049h\\033[2J\\033[HALT1\\r\\nALT2`, MODES),
		lines: ["l1", "l2", "l3", "l4"],
	},
	{
		name: "left the alternate screen cleanly, then printed more",
		agent: fakeAgent("a\\r\\nb\\r\\n\\033[?1049hALT\\033[?1049lc\\r\\nd\\r\\ne\\r\\nf", MODES),
		lines: ["a", "b", "c", "d", "e", "f"],
	},
];

describe.skipIf(!runnable)("run wrapper after a killed agent", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => {
		try {
			tmux("kill-server");
		} catch { /* already gone */ }
	});

	it.each(SCENARIOS)("restores the pane: $name", async ({ agent: agentSource, lines }) => {
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
		writeFileSync(agent, agentSource, { mode: 0o755 });
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

		// -J joins wrapped lines; bash's own "Killed" notice is noise, so compare the agent lines by their start.
		const screen = tmux("capture-pane", "-p", "-J");
		expect([...screen.matchAll(/^(l\d|[a-f])/gm)].map((match) => match[1])).toEqual(lines);
		expect(screen.indexOf("✗ Process exited with code 137")).toBeGreaterThan(screen.lastIndexOf(lines[lines.length - 1]));

		const tty = tmux("display", "-p", "#{pane_tty}");
		const settings = execFileSync("stty", process.platform === "darwin" ? ["-a", "-f", tty] : ["-F", tty, "-a"], {
			encoding: "utf-8",
		});
		expect(settings).toMatch(/(^|[\s;])icanon(?=[\s;]|$)/);
		expect(settings).toMatch(/(^|[\s;])echo(?=[\s;]|$)/);
	}, 15_000);
});
