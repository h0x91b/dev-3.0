/**
 * The git `info/exclude` rules dev3 adds for Claude files, against real git in
 * throwaway repos: what matters is what `git status` reports afterwards, which a
 * mocked spawn cannot show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Real git, through the wrapper's synchronous shape.
vi.mock("../spawn", async () => {
	const { spawnSync: nodeSpawnSync } = await import("node:child_process");
	const { GIT_CONFIG_ISOLATION: isolation } = await import("./git-test-helpers");
	return {
		spawnSync: (cmd: string[], opts?: { cwd?: string }) => {
			const res = nodeSpawnSync(cmd[0]!, cmd.slice(1), { cwd: opts?.cwd, env: { ...process.env, ...isolation } });
			return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr };
		},
	};
});

import { excludeClaudeRuntimeState, excludeTaskAgyConfig, excludeTaskClaudeSettings, excludeTaskCodexHooks } from "../claude-config-git";
import { GIT_CONFIG_ISOLATION } from "./git-test-helpers";

const ENV = {
	...process.env,
	...GIT_CONFIG_ISOLATION,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

function sh(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, env: ENV, stdio: "pipe", encoding: "utf-8" });
}

function writeTaskSettings(dir: string): void {
	mkdirSync(join(dir, ".claude"), { recursive: true });
	writeFileSync(join(dir, ".claude", "settings.local.json"), "{\"hooks\":{}}\n");
}

function writeTaskCodexHooks(dir: string): void {
	mkdirSync(join(dir, ".codex"), { recursive: true });
	writeFileSync(join(dir, ".codex", "hooks.json"), "{\"hooks\":{}}\n");
}

let root: string;
let repo: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-claude-config-git-"));
	repo = join(root, "repo");
	mkdirSync(repo);
	sh("git init -q -b main && git commit -q --allow-empty -m first", repo);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("excludeTaskClaudeSettings", () => {
	it("hides dev3's settings file in a task worktree, so the branch reads as clean", () => {
		const worktree = join(root, "wt");
		sh(`git worktree add -q -b task "${worktree}"`, repo);
		writeTaskSettings(worktree);
		expect(sh("git status --porcelain", worktree)).toContain(".claude/");

		excludeTaskClaudeSettings(worktree);

		expect(sh("git status --porcelain", worktree)).toBe("");
		expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain("/.claude/settings.local.json");
	});

	it("leaves other untracked work under .claude visible", () => {
		const worktree = join(root, "wt2");
		sh(`git worktree add -q -b task2 "${worktree}"`, repo);
		writeTaskSettings(worktree);
		writeFileSync(join(worktree, ".claude", "agents.md"), "mine\n");

		excludeTaskClaudeSettings(worktree);

		expect(sh("git status --porcelain -uall", worktree).trim()).toBe("?? .claude/agents.md");
	});

	it("anchors the rule at the task folder inside the repo", () => {
		const sub = join(repo, "packages", "app");
		mkdirSync(sub, { recursive: true });
		writeTaskSettings(sub);

		excludeTaskClaudeSettings(sub);

		expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain("/packages/app/.claude/settings.local.json");
		expect(sh("git status --porcelain -uall", repo)).toBe("");
	});

	it("adds nothing when the repo tracks the file", () => {
		const tracked = join(root, "tracked");
		mkdirSync(tracked);
		sh("git init -q -b main", tracked);
		writeTaskSettings(tracked);
		sh("git add .claude/settings.local.json && git commit -q -m settings", tracked);

		excludeTaskClaudeSettings(tracked);

		expect(readFileSync(join(tracked, ".git", "info", "exclude"), "utf-8")).not.toContain("settings.local.json");
	});

	it("does nothing outside a git repo", () => {
		const plain = join(root, "plain");
		writeTaskSettings(plain);
		expect(() => excludeTaskClaudeSettings(plain)).not.toThrow();
	});
});

describe("excludeTaskCodexHooks", () => {
	it("hides dev3's Codex hooks file in a task worktree, so the branch reads as clean", () => {
		const worktree = join(root, "wt");
		sh(`git worktree add -q -b task "${worktree}"`, repo);
		writeTaskCodexHooks(worktree);
		expect(sh("git status --porcelain", worktree)).toContain(".codex/");

		excludeTaskCodexHooks(worktree);

		expect(sh("git status --porcelain", worktree)).toBe("");
		expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain("/.codex/hooks.json");
	});

	it("adds the rule once for several worktrees of one repo", () => {
		const first = join(root, "wt-a");
		const second = join(root, "wt-b");
		sh(`git worktree add -q -b task-a "${first}"`, repo);
		sh(`git worktree add -q -b task-b "${second}"`, repo);
		writeTaskCodexHooks(first);
		writeTaskCodexHooks(second);

		excludeTaskCodexHooks(first);
		excludeTaskCodexHooks(second);

		const rules = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8").split("\n").filter((line) => line === "/.codex/hooks.json");
		expect(rules).toHaveLength(1);
		expect(sh("git status --porcelain", second)).toBe("");
	});

	it("leaves the user's other .codex files visible", () => {
		const worktree = join(root, "wt2");
		sh(`git worktree add -q -b task2 "${worktree}"`, repo);
		writeTaskCodexHooks(worktree);
		writeFileSync(join(worktree, ".codex", "config.toml"), "model = \"x\"\n");

		excludeTaskCodexHooks(worktree);

		expect(sh("git status --porcelain -uall", worktree).trim()).toBe("?? .codex/config.toml");
	});

	it("anchors the rule at the task folder inside the repo", () => {
		const sub = join(repo, "packages", "app");
		mkdirSync(sub, { recursive: true });
		writeTaskCodexHooks(sub);

		excludeTaskCodexHooks(sub);

		expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain("/packages/app/.codex/hooks.json");
		expect(sh("git status --porcelain -uall", repo)).toBe("");
	});

	it("adds nothing when the repo tracks the file, which stays visible once modified", () => {
		const tracked = join(root, "tracked");
		mkdirSync(tracked);
		sh("git init -q -b main", tracked);
		writeTaskCodexHooks(tracked);
		sh("git add .codex/hooks.json && git commit -q -m hooks", tracked);
		writeFileSync(join(tracked, ".codex", "hooks.json"), "{\"hooks\":{\"Stop\":[]}}\n");

		excludeTaskCodexHooks(tracked);

		expect(readFileSync(join(tracked, ".git", "info", "exclude"), "utf-8")).not.toContain("hooks.json");
		expect(sh("git status --porcelain", tracked).trim()).toBe("M .codex/hooks.json");
	});

	it("does nothing outside a git repo", () => {
		const plain = join(root, "plain");
		writeTaskCodexHooks(plain);
		expect(() => excludeTaskCodexHooks(plain)).not.toThrow();
	});
});

describe("excludeClaudeRuntimeState", () => {
	it("still excludes a pinned config dir's runtime state", () => {
		const configDir = join(repo, ".claude");
		mkdirSync(join(configDir, "projects"), { recursive: true });
		writeFileSync(join(configDir, "history.jsonl"), "{}\n");
		writeFileSync(join(configDir, "projects", "x.jsonl"), "{}\n");

		excludeClaudeRuntimeState(configDir, ["dev3"]);

		expect(sh("git status --porcelain -uall", repo)).toBe("");
		expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain("/.claude/history.jsonl");
	});
});

describe("excludeTaskAgyConfig", () => {
	function writeAgyConfig(dir: string): void {
		mkdirSync(join(dir, ".agents", "skills", "dev3"), { recursive: true });
		writeFileSync(join(dir, ".agents", "hooks.json"), "{}\n");
		writeFileSync(join(dir, ".agents", "skills", "dev3", "SKILL.md"), "skill\n");
	}

	it("hides the hooks file and the dev3 skill, so the branch reads as clean", () => {
		const worktree = join(root, "wt-agy");
		sh(`git worktree add -q -b task-agy "${worktree}"`, repo);
		writeAgyConfig(worktree);

		excludeTaskAgyConfig(worktree);

		expect(sh("git status --porcelain", worktree)).toBe("");
		const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8");
		expect(exclude).toContain("/.agents/hooks.json");
		expect(exclude).toContain("/.agents/skills/dev3/");
	});

	it("leaves the user's other .agents files visible", () => {
		const worktree = join(root, "wt-agy2");
		sh(`git worktree add -q -b task-agy2 "${worktree}"`, repo);
		writeAgyConfig(worktree);
		mkdirSync(join(worktree, ".agents", "rules"), { recursive: true });
		writeFileSync(join(worktree, ".agents", "rules", "mine.md"), "rule\n");

		excludeTaskAgyConfig(worktree);

		expect(sh("git status --porcelain -uall", worktree).trim()).toBe("?? .agents/rules/mine.md");
	});

	it("adds no rule for a hooks file the repo tracks", () => {
		const tracked = join(root, "tracked-agy");
		mkdirSync(tracked);
		sh("git init -q -b main", tracked);
		writeAgyConfig(tracked);
		sh("git add .agents/hooks.json && git commit -q -m hooks", tracked);

		excludeTaskAgyConfig(tracked);

		const exclude = readFileSync(join(tracked, ".git", "info", "exclude"), "utf-8");
		expect(exclude).not.toContain("hooks.json");
		expect(exclude).toContain("/.agents/skills/dev3/");
	});

	it("does nothing outside a git repo", () => {
		const plain = join(root, "plain-agy");
		writeAgyConfig(plain);
		expect(() => excludeTaskAgyConfig(plain)).not.toThrow();
	});
});
