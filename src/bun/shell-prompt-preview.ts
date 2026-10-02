// Renders a prompt style the way a dev3 shell pane would show it, by running
// the real zsh prompt engine against a throwaway demo repository. Settings uses
// it for every style's preview and to reject custom code zsh cannot parse.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellPromptPreview } from "../shared/types";
import { ZSH_PROMPT_ENGINE } from "./shell-init";
import { spawn, spawnSync } from "./spawn";
import { dev3TempPath } from "./temp-paths";

const PREVIEW_ROOT = dev3TempPath("dev3-prompt-preview-v1");
const DEMO_WORKTREE = join(PREVIEW_ROOT, "my-app");
const DEMO_CWD = join(DEMO_WORKTREE, "src", "api");
const PREVIEW_TIMEOUT_MS = 5_000;
const STATE_BREAK = "\u001f";

/** A repo with one staged, two modified and one untracked file, two commits ahead of its upstream. */
function ensureDemoWorktree(): void {
	if (existsSync(join(DEMO_WORKTREE, ".git"))) return;
	mkdirSync(DEMO_CWD, { recursive: true });
	const origin = join(PREVIEW_ROOT, "origin.git");
	const git = (cwd: string, ...args: string[]) =>
		spawnSync(["git", "-c", "user.email=demo@example.com", "-c", "user.name=demo", ...args], { cwd });
	git(PREVIEW_ROOT, "init", "-q", "--bare", origin);
	git(DEMO_WORKTREE, "init", "-q", "-b", "feat/new-login");
	for (const file of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(DEMO_CWD, file), "1\n");
	git(DEMO_WORKTREE, "add", "-A");
	git(DEMO_WORKTREE, "commit", "-qm", "init");
	git(DEMO_WORKTREE, "remote", "add", "origin", origin);
	git(DEMO_WORKTREE, "push", "-q", "-u", "origin", "feat/new-login");
	for (const n of [2, 3]) {
		writeFileSync(join(DEMO_CWD, "a.ts"), `${n}\n`);
		git(DEMO_WORKTREE, "commit", "-qam", `c${n}`);
	}
	writeFileSync(join(DEMO_CWD, "a.ts"), "staged\n");
	git(DEMO_WORKTREE, "add", join("src", "api", "a.ts"));
	writeFileSync(join(DEMO_CWD, "b.ts"), "changed\n");
	writeFileSync(join(DEMO_CWD, "c.ts"), "changed\n");
	writeFileSync(join(DEMO_CWD, "new.ts"), "new\n");
}

// Two prompts: after a command that ran 3 seconds, then after one that failed.
export const PREVIEW_RENDER_SCRIPT = `
source "$DEV3_PREVIEW_ENGINE"
eval "$DEV3_PREVIEW_STYLE" || exit 3
# A real shell hands %? the command's status even after precmd ran; restore it.
_dev3_render() {
  local rc=$?
  _dev3_precmd
  (exit $rc); print -P -- "$PROMPT"
  print -rn -- $'${STATE_BREAK}'
  (exit $rc); print -P -- "$RPROMPT"
  print -rn -- $'${STATE_BREAK}'
}
_dev3_t0=$(( EPOCHREALTIME - 3 )); true; _dev3_render
false; _dev3_render
`;

/** Pad the last prompt line so a right prompt lands against the right edge. */
function joinRightPrompt(left: string, right: string, columns: number): string[] {
	const lines = left.replace(/\n$/, "").split("\n");
	const rightText = right.replace(/\n$/, "");
	if (!rightText) return lines;
	const visible = (s: string) => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;
	const last = lines.length - 1;
	const gap = Math.max(1, columns - visible(lines[last]) - visible(rightText) - 1);
	lines[last] = `${lines[last]}${" ".repeat(gap)}${rightText}`;
	return lines;
}

export async function previewShellPrompt(source: string, columns = 72): Promise<ShellPromptPreview> {
	if (process.platform === "win32") return { ok: false, reason: "no-zsh" };
	let parse: ReturnType<typeof spawnSync>;
	try {
		parse = spawnSync(["zsh", "-f", "-n", "-c", source], { stderr: "pipe", stdout: "pipe" });
	} catch {
		return { ok: false, reason: "no-zsh" };
	}
	if (parse.exitCode !== 0) {
		return { ok: false, reason: "invalid", error: parse.stderr.toString().trim().replace(/^zsh:\d+: /, "") };
	}
	ensureDemoWorktree();
	const enginePath = join(PREVIEW_ROOT, "engine.zsh");
	writeFileSync(enginePath, ZSH_PROMPT_ENGINE);
	const proc = spawn(["zsh", "-f", "-c", PREVIEW_RENDER_SCRIPT], {
		cwd: DEMO_CWD,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			HOME: PREVIEW_ROOT,
			HOST: "devbox",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			COLUMNS: String(columns),
			DEV3_WORKTREE_ROOT: DEMO_WORKTREE,
			DEV3_PROJECT_NAME: "my-app",
			DEV3_TASK_SEQ: "42",
			DEV3_PREVIEW_ENGINE: enginePath,
			// The login name is the one real identity a style can print; the host is already faked.
			DEV3_PREVIEW_STYLE: source.replaceAll("%n", "you"),
		},
	});
	const timer = setTimeout(() => proc.kill(9), PREVIEW_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	if (exitCode !== 0) {
		return { ok: false, reason: "invalid", error: stderr.trim().replace(/^zsh:\d+: /, "") || `exit ${exitCode}` };
	}
	return parsePreviewOutput(stdout, columns);
}

/** Split what `PREVIEW_RENDER_SCRIPT` printed into the two prompt states. */
export function parsePreviewOutput(stdout: string, columns: number): ShellPromptPreview {
	const parts = stdout.split(STATE_BREAK);
	return {
		ok: true,
		afterSlowCommand: joinRightPrompt(parts[0] ?? "", parts[1] ?? "", columns),
		afterFailedCommand: joinRightPrompt(parts[2] ?? "", parts[3] ?? "", columns),
	};
}
