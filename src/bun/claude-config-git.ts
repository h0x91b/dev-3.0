/**
 * A Claude config dir pinned inside a git repo - typically a project's own
 * `.claude`, set through CLAUDE_CONFIG_DIR - also holds Claude's runtime state
 * and the skills dev3 installs. Keep both out of `git status` through the repo's
 * own `info/exclude`, which is never committed, the way auto-configure does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createLogger } from "./logger";
import { spawnSync } from "./spawn";

const log = createLogger("claude-config-git");

/** What Claude Code writes into its config dir at runtime, relative to that dir. */
export const CLAUDE_RUNTIME_STATE = [
	".claude.json",
	".claude.json.*",
	".credentials.json",
	".last-cleanup",
	".last-update-result.json",
	"history.jsonl",
	"stats-cache.json",
	"rate_tracking.json",
	"mcp-needs-auth-cache.json",
	"policy-limits.json",
	"policy-limits.json.*",
	"remote-settings.json",
	"remote-settings.json.*",
	"daemon.log",
	"projects/",
	"sessions/",
	"session-env/",
	"file-history/",
	"shell-snapshots/",
	"paste-cache/",
	"image-cache/",
	"cache/",
	"downloads/",
	"backups/",
	"todos/",
	"tasks/",
	"teams/",
	"statsig/",
	"ide/",
	"state/",
	"daemon/",
	"jobs/",
	"chrome/",
	"worktrees/",
] as const;

/** `info/exclude` rules for one config dir, anchored at the repo root via `prefix` (e.g. `.claude/`). */
export function claudeRuntimeExcludeRules(prefix: string, skillNames: readonly string[]): string[] {
	const base = `/${prefix.replace(/[\\*?[]/g, "\\$&")}`;
	return [...CLAUDE_RUNTIME_STATE, ...skillNames.map((name) => `skills/${name}/`)].map((entry) => `${base}${entry}`);
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
	const res = spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return { ok: res.exitCode === 0, stdout: res.stdout?.toString() ?? "" };
}

/** True when `file` is tracked by the git repo it sits in. */
export function isGitTracked(file: string): boolean {
	if (!existsSync(file)) return false;
	return git(["ls-files", "--error-unmatch", "--", basename(file)], dirname(file)).ok;
}

const excluded = new Set<string>();

/** Add the runtime-state rules for `configDir` to its repo's `info/exclude`. Once per dir per process; never throws. */
export function excludeClaudeRuntimeState(configDir: string, skillNames: readonly string[]): void {
	if (excluded.has(configDir) || !existsSync(configDir)) return;
	excluded.add(configDir);
	try {
		const res = git(["rev-parse", "--git-path", "info/exclude", "--show-prefix"], configDir);
		if (!res.ok) return;
		const [gitPath, prefix = "", ...rest] = res.stdout.split("\n");
		if (!gitPath || rest.some((line) => line.length > 0)) return;
		const excludePath = isAbsolute(gitPath) ? gitPath : join(configDir, gitPath);
		const content = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
		const present = new Set(content.split("\n").map((line) => line.trimEnd()));
		const missing = claudeRuntimeExcludeRules(prefix, skillNames).filter((rule) => !present.has(rule));
		if (missing.length === 0) return;
		mkdirSync(dirname(excludePath), { recursive: true });
		const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		writeFileSync(excludePath, `${content}${separator}# dev3: Claude runtime state in ${prefix}\n${missing.join("\n")}\n`);
		log.info("Excluded Claude runtime state from git", { configDir, rules: missing.length });
	} catch (err) {
		log.warn("Failed to exclude Claude runtime state (non-fatal)", { configDir, error: String(err) });
	}
}
