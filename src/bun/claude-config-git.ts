/**
 * A Claude config dir pinned inside a git repo - typically a project's own
 * `.claude`, set through CLAUDE_CONFIG_DIR - also holds Claude's runtime state
 * and the skills dev3 installs. Keep both out of `git status` through the repo's
 * own `info/exclude`, which is never committed, the way auto-configure does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Project } from "../shared/types";
import { normalizeClaudeConfigDir } from "../shared/claude-config-dir";
import { CLAUDE_SKILL_NAMES } from "./agent-skills";
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

/** The nearest existing ancestor of `dir` (itself included), and the path from it down to `dir` with forward slashes. */
function nearestExisting(dir: string): { base: string; tail: string } | null {
	let base = dir;
	while (!existsSync(base)) {
		const parent = dirname(base);
		if (parent === base) return null;
		base = parent;
	}
	return { base, tail: relative(base, dir).replaceAll("\\", "/") };
}

const excluded = new Set<string>();

/**
 * Add the runtime-state rules for `configDir` to its repo's `info/exclude`, before
 * Claude creates the dir if need be. Once per dir per process; never throws.
 */
export function excludeClaudeRuntimeState(configDir: string, skillNames: readonly string[]): void {
	if (excluded.has(configDir)) return;
	const located = nearestExisting(configDir);
	if (!located) return;
	excluded.add(configDir);
	try {
		const res = git(["rev-parse", "--git-path", "info/exclude", "--show-prefix"], located.base);
		if (!res.ok) return;
		const [gitPath, gitPrefix = "", ...rest] = res.stdout.split("\n");
		if (!gitPath || rest.some((line) => line.length > 0)) return;
		const prefix = located.tail ? `${gitPrefix}${located.tail}/` : gitPrefix;
		const excludePath = isAbsolute(gitPath) ? gitPath : join(located.base, gitPath);
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

/** True when git ignores the `.credentials.json` Claude Code would write into `configDir`. A tracked file is not ignored. */
export function claudeLoginIgnoredByGit(configDir: string): boolean {
	const located = nearestExisting(configDir);
	if (!located) return false;
	const file = located.tail ? `${located.tail}/.credentials.json` : ".credentials.json";
	return git(["check-ignore", "-q", "--", file], located.base).ok;
}

const refused = new Set<string>();

/**
 * Whether a global `CLAUDE_CONFIG_DIR` default naming a folder relative to the project
 * may apply to it. Operations boards never take one: their folder is dev3's own data.
 * macOS keeps Claude's login in the Keychain; elsewhere it lands in `.credentials.json`
 * inside the dir, so the dir is used only when git ignores that file once dev3 has
 * written its `info/exclude` rules (`decisions/2026/11/11/project-claude-folder-on-every-os.md`).
 */
export function projectClaudeConfigDirAllowed(
	project: Pick<Project, "kind" | "path">,
	value: string,
	platform: string = process.platform,
): boolean {
	if (project.kind === "virtual") return false;
	if (platform === "darwin") return true;
	const dir = normalizeClaudeConfigDir(value, homedir(), project.path);
	if (!dir) return false;
	excludeClaudeRuntimeState(dir, CLAUDE_SKILL_NAMES);
	if (claudeLoginIgnoredByGit(dir)) return true;
	if (!refused.has(dir)) {
		refused.add(dir);
		log.info("Per-project Claude folder not used: git would not ignore its login file", { dir });
	}
	return false;
}
