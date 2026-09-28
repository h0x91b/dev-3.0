import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFenceCloseLines, agentFenceOpenLines } from "../agent-fence-wrapper";
import { buildCmdScript } from "../rpc-handlers/shared-pure";

const FENCE = {
	tmuxBinary: "/opt/dev3/tmux",
	launchId: "5d1f2a9e-0000-4000-8000-000000000000",
	taskId: "0123abcd-0000-4000-8000-000000000000",
	racedDir: "/home/u/.dev3.0/worktrees/p/0123abcd/messages",
	fenceDir: "/home/u/.dev3.0/agent-fence",
};

function script(opts: Parameters<typeof buildCmdScript>[2]): string[] {
	return buildCmdScript("codex --yolo", {}, opts).split("\n");
}

describe("buildCmdScript with the agent delivery fence", () => {
	it.skipIf(process.platform === "win32")("opens the fence before the agent and closes it before any notice or shell", () => {
		const lines = script({ keepShell: true, shellPath: "/bin/zsh", agentFence: FENCE });
		const start = lines.findIndex((l) => l.includes("Starting: codex --yolo"));
		const open = lines.findIndex((l) => l.includes(`"open:$__DEV3_FLAUNCH"`));
		const exit = lines.indexOf("__EC=$?");
		const close = lines.findIndex((l) => l.includes("__dev3_own_close \"$__EC\""));
		const untrap = lines.lastIndexOf("trap - INT QUIT TSTP");
		const notice = lines.findIndex((l) => l.includes("Process exited with code"));
		const shell = lines.findIndex((l) => l.startsWith("exec "));
		expect(open).toBeGreaterThan(-1);
		expect(open).toBeLessThan(start);
		expect(lines[exit + 1]).toBe("trap '' INT QUIT TSTP");
		expect(close).toBeGreaterThan(exit);
		expect(untrap).toBeGreaterThan(close);
		expect(untrap).toBeLessThan(notice);
		expect(notice).toBeLessThan(shell);
		// The binary is the committed absolute one, and every call names the pane's own server.
		expect(lines).toContain("__DEV3_FTMUX='/opt/dev3/tmux'");
		expect(lines.join("\n")).toContain('"$__DEV3_FTMUX" -S "${TMUX%%,*}"');
	});

	it("adds nothing without keepShell: that pane closes with its agent", () => {
		expect(script({ agentFence: FENCE }).join("\n")).not.toContain("__DEV3_F");
		expect(script({ keepShell: true }).join("\n")).not.toContain("__DEV3_F");
	});

	it("refuses unsafe inputs instead of quoting them", () => {
		expect(() => agentFenceOpenLines({ ...FENCE, tmuxBinary: "tmux" })).toThrow(/absolute/);
		expect(() => agentFenceOpenLines({ ...FENCE, launchId: "a;b" })).toThrow();
		expect(() => agentFenceOpenLines({ ...FENCE, taskId: "x y" })).toThrow();
		expect(() => agentFenceCloseLines("__EC; rm")).toThrow();
	});

	// The wrapper runs under the user's login shell with the shebang ignored.
	const shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/usr/bin/dash"].filter((s) => existsSync(s));
	it.skipIf(process.platform === "win32" || shells.length === 0).each(shells)("parses under %s", (shell) => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-fence-wrapper-"));
		const path = join(dir, "run.sh");
		writeFileSync(path, script({ keepShell: true, shellPath: shell, agentFence: FENCE }).join("\n"));
		const result = spawnSync(shell, ["-n", path], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
