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

/**
 * Append the rules `rulesFor(prefix)` builds to the `info/exclude` of the repo `dir`
 * sits in (never committed), skipping rules already there. `prefix` is `dir` relative
 * to the repo root. Once per key per process; never throws.
 */
function addExcludeRules(key: string, dir: string, rulesFor: (prefix: string) => string[], label: string): void {
	if (excluded.has(key) || !existsSync(dir)) return;
	excluded.add(key);
	try {
		const res = git(["rev-parse", "--git-path", "info/exclude", "--show-prefix"], dir);
		if (!res.ok) return;
		const [gitPath, prefix = "", ...rest] = res.stdout.split("\n");
		if (!gitPath || rest.some((line) => line.length > 0)) return;
		const excludePath = isAbsolute(gitPath) ? gitPath : join(dir, gitPath);
		const content = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
		const present = new Set(content.split("\n").map((line) => line.trimEnd()));
		const missing = rulesFor(prefix).filter((rule) => !present.has(rule));
		if (missing.length === 0) return;
		mkdirSync(dirname(excludePath), { recursive: true });
		const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		writeFileSync(excludePath, `${content}${separator}# dev3: ${label} in ${prefix}\n${missing.join("\n")}\n`);
		log.info("Excluded from git", { dir, label, rules: missing.length });
	} catch (err) {
		log.warn("Failed to write git exclude rules (non-fatal)", { dir, label, error: String(err) });
	}
}

/** Add the runtime-state rules for `configDir` to its repo's `info/exclude`. Once per dir per process; never throws. */
export function excludeClaudeRuntimeState(configDir: string, skillNames: readonly string[]): void {
	addExcludeRules(`runtime:${configDir}`, configDir, (prefix) => claudeRuntimeExcludeRules(prefix, skillNames), "Claude runtime state");
}

/**
 * dev3 writes Claude's hooks and approvals into the task folder's
 * `.claude/settings.local.json`. Untracked, it reads as uncommitted work: it holds
 * back the merge-completion offer and warns on Complete. Exclude it unless the
 * repo tracks it. Never throws.
 */
export function excludeTaskClaudeSettings(taskDir: string): void {
	const file = join(taskDir, ".claude", "settings.local.json");
	if (!existsSync(file) || isGitTracked(file)) return;
	addExcludeRules(`task-settings:${taskDir}`, taskDir, (prefix) => [`/${prefix.replace(/[\\*?[]/g, "\\$&")}.claude/settings.local.json`], "dev3 task settings");
}
