import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_INIT_DIR, writeShellInit } from "../shell-init";

describe("shell init word motion", () => {
	beforeAll(() => {
		writeShellInit();
	});

	it("binds modifier+arrow to word motion in zsh, after the user's .zshrc", () => {
		const zshrc = readFileSync(`${SHELL_INIT_DIR}/.zshrc`, "utf8");
		for (const [seq, widget] of [
			["^[[1;3D", "backward-word"],
			["^[[1;3C", "forward-word"],
			["^[[1;5D", "backward-word"],
			["^[[1;5C", "forward-word"],
		]) {
			expect(zshrc).toContain(`bindkey "${seq}" ${widget}`);
			// Order matters: sourcing the user's config later would clobber these.
			expect(zshrc.indexOf(seq)).toBeGreaterThan(zshrc.indexOf('source "$HOME/.zshrc"'));
		}
	});

	it("binds modifier+arrow to word motion in bash", () => {
		const bashrc = readFileSync(`${SHELL_INIT_DIR}/.bashrc`, "utf8");
		expect(bashrc).toContain(String.raw`bind '"\e[1;3D": backward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;3C": forward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;5D": backward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;5C": forward-word'`);
	});
});

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function hasShell(name: string): boolean {
	return process.platform !== "win32" && spawnSync(name, ["-c", "exit 0"]).status === 0;
}

/** A worktree with one staged, one modified and one untracked file. */
function dirtyWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "dev3-prompt-"));
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd: dir });
	git("init", "-q", "-b", "feat/a-very-long-branch-name-nobody-wants-to-read");
	mkdirSync(join(dir, "src/bun"), { recursive: true });
	writeFileSync(join(dir, "a.txt"), "a");
	writeFileSync(join(dir, "b.txt"), "b");
	git("add", "-A");
	git("commit", "-qm", "init");
	writeFileSync(join(dir, "a.txt"), "a2");
	git("add", "a.txt");
	writeFileSync(join(dir, "b.txt"), "b2");
	writeFileSync(join(dir, "new.txt"), "n");
	return dir;
}

/** First prompt line exactly as the terminal would show it. */
function promptLine(shell: "zsh" | "bash", worktree: string, cwd: string, columns: number): string {
	const script =
		shell === "zsh"
			? `source ${SHELL_INIT_DIR}/.zshrc; COLUMNS=${columns}; _dev3_precmd; print -rn -- "\${(%)_dev3_line}"`
			: `source ${SHELL_INIT_DIR}/.bashrc; COLUMNS=${columns}; _dev3_prompt; printf '%s' "\${PS1%%\\\\n*}"`;
	const env = {
		PATH: process.env.PATH,
		HOME: worktree,
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		DEV3_WORKTREE_ROOT: worktree,
		DEV3_PROJECT_NAME: "dev-3.0",
		DEV3_TASK_SEQ: "2063-1",
	};
	const args = shell === "zsh" ? ["-f", "-c", script] : ["--noprofile", "--norc", "-c", script];
	const out = spawnSync(shell, args, { cwd, env, encoding: "utf8" });
	expect(out.stderr).toBe("");
	return out.stdout.replace(SGR, "").replace(/\\\[|\\\]|\\e\[[0-9;]*m/g, "");
}

describe.each(["zsh", "bash"] as const)("dev3 %s prompt", (shell) => {
	const available = hasShell(shell);
	let worktree = "";

	beforeAll(() => {
		writeShellInit();
		if (available) worktree = dirtyWorktree();
	});

	it.skipIf(!available)("shows task, project, worktree-relative path and git counters — not the branch name", () => {
		const line = promptLine(shell, worktree, join(worktree, "src/bun"), 120);
		expect(line).toContain("#2063");
		expect(line).toContain("dev-3.0");
		expect(line).toContain("src/bun");
		expect(line).toContain("+1 ~1 ?1");
		expect(line).not.toContain("a-very-long-branch-name");
	});

	it.skipIf(!available)("drops segments instead of wrapping in a narrow pane", () => {
		for (const columns of [40, 28, 20, 14]) {
			const line = promptLine(shell, worktree, join(worktree, "src/bun"), columns);
			expect([...line].length).toBeLessThan(columns);
		}
	});

	it.skipIf(!available)("drops project, then task, then path — git changes outlive them", () => {
		const line = promptLine(shell, worktree, join(worktree, "src/bun"), 20);
		expect(line).not.toContain("dev-3.0");
		expect(line).not.toContain("#2063");
		expect(line).not.toContain("bun");
		expect(line).toContain("+1 ~1 ?1");
		expect(promptLine(shell, worktree, join(worktree, "src/bun"), 38)).toMatch(/^(?!.*dev-3\.0).*#2063.*src\/bun/);
	});
});
