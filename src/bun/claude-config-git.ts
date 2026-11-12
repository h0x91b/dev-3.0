/**
 * A Claude config dir pinned inside a git repo - typically a project's own
 * `.claude`, set through CLAUDE_CONFIG_DIR - also holds Claude's runtime state
 * and the skills dev3 installs. Keep both out of `git status` through the repo's
 * own `info/exclude`, which is never committed, the way auto-configure does.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Project } from "../shared/types";
import { normalizeClaudeConfigDir } from "../shared/claude-config-dir";
import { resolveDev3Home } from "../shared/dev3-home";
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

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const res = spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { LC_ALL: "C" } });
	return { ok: res.exitCode === 0, stdout: res.stdout?.toString() ?? "", stderr: res.stderr?.toString() ?? "" };
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
 * to the repo root. Once per key per process once written; never throws.
 */
function addExcludeRules(key: string, dir: string, rulesFor: (prefix: string) => string[], label: string): void {
	if (excluded.has(key) || !existsSync(dir)) return;
	try {
		const res = git(["rev-parse", "--git-path", "info/exclude", "--show-prefix"], dir);
		if (!res.ok) return;
		const [gitPath, prefix = "", ...rest] = res.stdout.split("\n");
		if (!gitPath || rest.some((line) => line.length > 0)) return;
		const excludePath = isAbsolute(gitPath) ? gitPath : join(dir, gitPath);
		const content = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
		const present = new Set(content.split("\n").map((line) => line.trimEnd()));
		const missing = rulesFor(prefix).filter((rule) => !present.has(rule));
		if (missing.length === 0) {
			excluded.add(key);
			return;
		}
		mkdirSync(dirname(excludePath), { recursive: true });
		const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		writeFileSync(excludePath, `${content}${separator}# dev3: ${label} in ${prefix}\n${missing.join("\n")}\n`);
		// Marked only once written, so a failed write is retried by the next launch.
		excluded.add(key);
		log.info("Excluded from git", { dir, label, rules: missing.length });
	} catch (err) {
		log.warn("Failed to write git exclude rules (non-fatal)", { dir, label, error: String(err) });
	}
}

/** Add the runtime-state rules for `configDir` to its repo's `info/exclude`. Once per dir per process once written; never throws. */
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

/** The nearest existing ancestor of `dir` (itself included), and the path from it down to `dir` with forward slashes. */
function nearestExisting(dir: string): { base: string; tail: string } | null {
	let base = dir;
	while (!existsSync(base)) {
		const parent = dirname(base);
		if (parent === base) return null;
		base = parent;
	}
	return { base, tail: relative(base, dir).split(sep).join("/") };
}

/**
 * A one-rule excludes file standing in for the `info/exclude` rule a launch writes, so the check
 * changes no repo. It lives in dev3's per-user home, not the shared tmpdir another user can pre-create.
 */
function loginRuleFile(): string {
	const dir = resolveDev3Home();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "claude-login-exclude");
	if (!existsSync(file) || readFileSync(file, "utf-8") !== ".credentials.json\n") writeFileSync(file, ".credentials.json\n");
	return file;
}

/**
 * True when the `.credentials.json` Claude Code would write into `configDir` stays out of git:
 * no work tree holds the dir, or git ignores the file. By default the launch's exclude rule is
 * assumed present (supplied through `core.excludesFile`); `assumeLaunchRule: false` asks git about
 * the repo as it is. A tracked file or a `.gitignore` negation is not ignored. Read-only; false on any error.
 */
export function claudeLoginKeptOutOfGit(configDir: string, opts: { assumeLaunchRule?: boolean } = {}): boolean {
	try {
		const located = nearestExisting(configDir);
		if (!located) return false;
		const base = realpathSync(located.base);
		const workTree = git(["rev-parse", "--is-inside-work-tree"], base);
		// Only a definite "no repo here" counts as out of git; dubious ownership and the like do not.
		if (!workTree.ok) return /not a git repository/i.test(workTree.stderr);
		if (workTree.stdout.trim() !== "true") return false;
		const file = located.tail ? `${located.tail}/.credentials.json` : ".credentials.json";
		const rule = opts.assumeLaunchRule === false ? [] : ["-c", `core.excludesFile=${loginRuleFile()}`];
		return git([...rule, "check-ignore", "-q", "--", file], base).ok;
	} catch (err) {
		log.warn("Could not check whether git ignores the Claude login (non-fatal)", { configDir, error: String(err) });
		return false;
	}
}

const refused = new Set<string>();

/**
 * Whether a global `CLAUDE_CONFIG_DIR` default naming a dir via `{projectPath}` applies to `project`.
 * Never on Operations boards; always on macOS (Keychain login); elsewhere only when the login stays
 * out of git (`decisions/2026/11/11/project-claude-folder-on-every-os.md`).
 */
export function projectClaudeConfigDirAllowed(
	project: Pick<Project, "kind" | "path">,
	value: string,
	platform: string = process.platform,
): boolean {
	if (project.kind === "virtual") return false;
	if (platform === "darwin") return true;
	const dir = normalizeClaudeConfigDir(value, homedir(), project.path);
	if (dir && claudeLoginKeptOutOfGit(dir)) return true;
	if (dir && !refused.has(dir)) {
		refused.add(dir);
		log.info("Per-project Claude folder not used: git would not ignore its login file", { dir });
	}
	return false;
}
