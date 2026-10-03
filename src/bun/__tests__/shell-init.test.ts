import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_FILE, SHELL_INIT_DIR, writeShellInit, ZSH_PROMPT_ENGINE } from "../shell-init";
import { parsePreviewOutput, PREVIEW_RENDER_SCRIPT } from "../shell-prompt-preview";
import { SHELL_PROMPT_STYLES } from "../../shared/shell-prompt-styles";

describe("shell init word motion", () => {
	beforeAll(() => {
		writeShellInit({});
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
			? `source ${SHELL_INIT_DIR}/.zshrc; COLUMNS=${columns}; _dev3_precmd; print -P -- "$PROMPT" | head -n 1`
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
	return out.stdout.replace(/\n$/, "").replace(SGR, "").replace(/\\\[|\\\]|\\e\[[0-9;]*m/g, "");
}

describe.each(["zsh", "bash"] as const)("dev3 %s prompt", (shell) => {
	const available = hasShell(shell);
	let worktree = "";

	beforeAll(() => {
		writeShellInit({});
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

// dev3's terminal repaints a white *background* dark (ansi-theme-adapt.ts), so a
// segment edge drawn on one turns into a dark notch — the timer's, once.
describe("dev3 zsh prompt colours", () => {
	it.skipIf(!hasShell("zsh"))("never asks for a white background, timer segment included", () => {
		writeShellInit({});
		const worktree = dirtyWorktree();
		const out = spawnSync(
			"zsh",
			["-f", "-c", `source ${SHELL_INIT_DIR}/.zshrc; COLUMNS=200; _dev3_t0=$(( EPOCHREALTIME - 3 )); _dev3_precmd; print -P -- "$PROMPT"`],
			{
				cwd: join(worktree, "src/bun"),
				env: { PATH: process.env.PATH, HOME: worktree, LANG: "en_US.UTF-8", DEV3_WORKTREE_ROOT: worktree, DEV3_TASK_SEQ: "42" },
				encoding: "utf8",
			},
		);
		expect(out.stdout.replace(SGR, "")).toContain("3s");
		const params = [...out.stdout.matchAll(new RegExp(`${ESC}\\[([0-9;]*)m`, "g"))].flatMap((m) => m[1].split(";"));
		expect(params).not.toContain("47");
		expect(params).not.toContain("107");
	});
});

describe("dev3 prompt style choice", () => {
	const zsh = hasShell("zsh");
	const zshrc = () => readFileSync(`${SHELL_INIT_DIR}/.zshrc`, "utf8");
	const bashrc = () => readFileSync(`${SHELL_INIT_DIR}/.bashrc`, "utf8");

	afterAll(() => writeShellInit({}));

	it("writes the chosen style into the prompt file the zshrc sources", () => {
		writeShellInit({ shellPrompt: "minimal" });
		expect(readFileSync(PROMPT_FILE, "utf8").trim()).toBe(SHELL_PROMPT_STYLES.find((s) => s.id === "minimal")!.source);
		expect(zshrc()).toContain(`source "${PROMPT_FILE}"`);
	});

	it("writes custom code verbatim, and the default style when the custom is empty", () => {
		writeShellInit({ shellPrompt: "custom", shellPromptCustom: "PROMPT='mine> '" });
		expect(readFileSync(PROMPT_FILE, "utf8").trim()).toBe("PROMPT='mine> '");
		writeShellInit({ shellPrompt: "custom", shellPromptCustom: "  " });
		expect(readFileSync(PROMPT_FILE, "utf8").trim()).toBe(SHELL_PROMPT_STYLES[0].source);
	});

	it("leaves zsh and bash prompts alone when the user keeps their own", () => {
		writeShellInit({ shellPrompt: "own" });
		expect(zshrc()).not.toContain("_dev3_precmd");
		expect(zshrc()).not.toContain("PROMPT=");
		expect(bashrc()).not.toContain("PS1=");
		expect(zshrc()).toContain('bindkey "^[[1;3D" backward-word');
	});

	it.skipIf(!zsh)("falls back to the default prompt when custom code does not parse", () => {
		const worktree = dirtyWorktree();
		writeShellInit({ shellPrompt: "custom", shellPromptCustom: "PROMPT='unterminated" });
		const out = spawnSync("zsh", ["-f", "-c", `source ${SHELL_INIT_DIR}/.zshrc; print -r -- "$PROMPT"`], {
			cwd: worktree,
			env: { PATH: process.env.PATH, HOME: worktree, DEV3_WORKTREE_ROOT: worktree },
			encoding: "utf8",
		});
		expect(out.stderr, out.stderr).toContain("dev3: the custom prompt failed to load");
		expect(out.stdout).toContain("${dev3_segments}");
	});

	// Bun.spawn is stubbed under vitest, so this drives the same script through node.
	it.skipIf(!zsh)("renders every built-in style through the preview script with real zsh", () => {
		const worktree = dirtyWorktree();
		const engine = join(worktree, ".git", "engine.zsh");
		writeFileSync(engine, ZSH_PROMPT_ENGINE);
		for (const style of SHELL_PROMPT_STYLES) {
			const out = spawnSync("zsh", ["-f", "-c", PREVIEW_RENDER_SCRIPT], {
				cwd: join(worktree, "src/bun"),
				env: {
					PATH: process.env.PATH,
					HOME: worktree,
					LANG: "en_US.UTF-8",
					DEV3_PREVIEW_COLUMNS: "72",
					DEV3_WORKTREE_ROOT: worktree,
					DEV3_TASK_SEQ: "42",
					DEV3_PREVIEW_ENGINE: engine,
					DEV3_PREVIEW_STYLE: style.source,
				},
				encoding: "utf8",
			});
			expect(out.stderr, style.id).toBe("");
			const preview = parsePreviewOutput(out.stdout, 72);
			if (!preview.ok) throw new Error(style.id);
			const failed = preview.afterFailedCommand.join("\n").replace(SGR, "");
			const slow = preview.afterSlowCommand.join("\n").replace(SGR, "");
			expect(slow.trim().length, style.id).toBeGreaterThan(0);
			expect(failed, style.id).not.toContain("dev3_");
		}
	});

	it.skipIf(!zsh)("previews at the width it was asked for, not the width zsh inherited", () => {
		const worktree = dirtyWorktree();
		const engine = join(worktree, ".git", "engine.zsh");
		writeFileSync(engine, ZSH_PROMPT_ENGINE);
		const out = spawnSync("zsh", ["-f", "-c", PREVIEW_RENDER_SCRIPT], {
			cwd: join(worktree, "src/bun"),
			env: {
				PATH: process.env.PATH,
				HOME: worktree,
				LANG: "en_US.UTF-8",
				COLUMNS: "19",
				DEV3_PREVIEW_COLUMNS: "72",
				DEV3_WORKTREE_ROOT: worktree,
				DEV3_TASK_SEQ: "42",
				DEV3_PREVIEW_ENGINE: engine,
				DEV3_PREVIEW_STYLE: SHELL_PROMPT_STYLES[0].source,
			},
			encoding: "utf8",
		});
		const preview = parsePreviewOutput(out.stdout, 72);
		if (!preview.ok) throw new Error(out.stderr);
		expect(preview.afterSlowCommand[0].replace(SGR, "")).toContain("#42");
	});

	it.skipIf(!zsh)("every built-in style parses", () => {
		for (const style of SHELL_PROMPT_STYLES) {
			expect(spawnSync("zsh", ["-f", "-n", "-c", style.source]).status, style.id).toBe(0);
		}
	});

});
