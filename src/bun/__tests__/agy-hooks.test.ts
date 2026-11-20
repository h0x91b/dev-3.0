import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Real git, through the wrapper's synchronous shape, so isGitTracked sees the repo.
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
vi.mock("../claude-config-git", async (importActual) => ({
	...(await importActual<typeof import("../claude-config-git")>()),
	excludeTaskAgyConfig: vi.fn(),
}));

import { agyHookCommand, agyHookDialect, agyStatusLineCommand, buildAgyHooks, mergeAgyHooks, writeAgyHooks } from "../../shared/agent-hooks";
import { setupAgentHooks } from "../agent-hooks";
import { excludeTaskAgyConfig } from "../claude-config-git";
import { GIT_CONFIG_ISOLATION } from "./git-test-helpers";

const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true };
const WINDOWS = { cli: "\"C:/dev3/dev3.exe\"", posixShell: false };

let tempHome: string;
let worktree: string;
const originalDev3Home = process.env.DEV3_HOME;

beforeEach(() => {
	vi.mocked(excludeTaskAgyConfig).mockClear();
	tempHome = mkdtempSync(join(tmpdir(), "dev3-agy-home-"));
	worktree = join(tempHome, "worktrees", "proj", "abcd1234", "worktree");
	mkdirSync(worktree, { recursive: true });
	process.env.DEV3_HOME = tempHome;
});

afterEach(() => {
	if (originalDev3Home === undefined) delete process.env.DEV3_HOME;
	else process.env.DEV3_HOME = originalDev3Home;
	rmSync(tempHome, { recursive: true, force: true });
});

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("agy hook commands", () => {
	it("guards the POSIX command on DEV3_TASK_ID and still answers JSON when it skips", () => {
		expect(agyHookCommand("SessionStart", POSIX))
			.toBe(`sh -c '[ -z "$DEV3_TASK_ID" ] && echo {} || exec ~/.dev3.0/bin/dev3 hook agy SessionStart'`);
	});

	it("keeps the bare command on Windows, where a POSIX guard is not valid", () => {
		expect(agyHookCommand("Stop", WINDOWS)).toBe("\"C:/dev3/dev3.exe\" hook agy Stop");
	});

	// agy expands `~` against the launcher's HOME, so the spelled CLI must be absolute.
	it("spells the CLI as an absolute path under the account home, quoted when it needs it", () => {
		const plain = agyHookDialect("/Users/me");
		expect(plain).toEqual({ cli: "/Users/me/.dev3.0/bin/dev3", posixShell: true });
		expect(agyHookCommand("Stop", plain)).toBe(`sh -c '[ -z "$DEV3_TASK_ID" ] && echo {} || exec /Users/me/.dev3.0/bin/dev3 hook agy Stop'`);
		expect(agyStatusLineCommand({ dialect: plain })).toBe(`sh -c '[ -z "$DEV3_TASK_ID" ] || exec /Users/me/.dev3.0/bin/dev3 statusline agy'`);
		expect(agyHookCommand("Stop", plain)).not.toContain("~");

		const spaced = agyHookDialect("/Users/me/my home/");
		expect(spaced.cli).toBe(`'/Users/me/my home/.dev3.0/bin/dev3'`);
		// The quoted path sits inside sh -c's own single quotes, so its quotes are escaped.
		expect(agyHookCommand("Stop", spaced)).toContain(`exec '\\''/Users/me/my home/.dev3.0/bin/dev3'\\'' hook agy Stop'`);
	});

	it("subscribes to the three events agy offers, as flat handler lists under one named entry", () => {
		const entry = buildAgyHooks({ dialect: POSIX }) as Record<string, Array<Record<string, unknown>>>;
		expect(Object.keys(entry)).toEqual(["SessionStart", "PreInvocation", "Stop"]);
		for (const [event, handlers] of Object.entries(entry)) {
			expect(handlers).toHaveLength(1);
			expect(handlers[0]).toMatchObject({ type: "command", timeout: expect.any(Number) });
			expect(handlers[0]!.command).toContain(`hook agy ${event}`);
		}
	});
});

describe("writeAgyHooks", () => {
	const hooksPath = () => join(worktree, ".agents", "hooks.json");

	it("creates hooks.json with only dev3's entry, and rewrites nothing the second time", () => {
		expect(writeAgyHooks(worktree)).toEqual({ written: true, skippedSymlink: null, skippedUnreadable: false });
		expect(Object.keys(readJson(hooksPath()))).toEqual(["dev3"]);
		expect(JSON.stringify(readJson(hooksPath()))).toContain("~/.dev3.0/bin/dev3");
		expect(writeAgyHooks(worktree).written).toBe(false);
	});

	it("keeps the user's own hooks and replaces only the dev3 entry", () => {
		mkdirSync(join(worktree, ".agents"), { recursive: true });
		const mine = { mine: { Stop: [{ type: "command", command: "echo done" }] }, dev3: { Stop: [{ type: "command", command: "old" }] } };
		writeFileSync(hooksPath(), JSON.stringify(mine));

		writeAgyHooks(worktree);

		const after = readJson(hooksPath());
		expect(after.mine).toEqual(mine.mine);
		expect(JSON.stringify(after.dev3)).not.toContain("old");
		expect(JSON.stringify(after.dev3)).toContain("hook agy Stop");
		expect(mergeAgyHooks(mine, { dialect: POSIX }).mine).toEqual(mine.mine);
	});

	it("leaves a hooks.json that is not a JSON object exactly as found", () => {
		mkdirSync(join(worktree, ".agents"), { recursive: true });
		writeFileSync(hooksPath(), "{ not json");
		expect(writeAgyHooks(worktree)).toMatchObject({ written: false, skippedUnreadable: true });
		expect(readFileSync(hooksPath(), "utf-8")).toBe("{ not json");
		writeFileSync(hooksPath(), "[]");
		expect(writeAgyHooks(worktree).skippedUnreadable).toBe(true);
	});

	it("writes nothing through a symlinked .agents directory", () => {
		const outside = mkdtempSync(join(tmpdir(), "dev3-agy-outside-"));
		try {
			symlinkSync(outside, join(worktree, ".agents"));
			const result = writeAgyHooks(worktree);
			expect(result.written).toBe(false);
			expect(result.skippedSymlink).toBe(join(worktree, ".agents"));
			expect(existsSync(join(outside, "hooks.json"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("setupAgentHooks for agy", () => {
	it("writes the hooks and the dev3 skill into a worktree and excludes them from git", async () => {
		const launch = await setupAgentHooks(worktree, "agy");

		expect(launch).toBeNull();
		expect(readJson(join(worktree, ".agents", "hooks.json")).dev3.SessionStart).toBeDefined();
		const skill = readFileSync(join(worktree, ".agents", "skills", "dev3", "SKILL.md"), "utf-8");
		expect(skill).toContain("name: dev3");
		expect(skill).toContain("native hooks into every agy pane");
		expect(excludeTaskAgyConfig).toHaveBeenCalledWith(worktree);
	});

	it("runs the dev3 CLI from the ACCOUNT home, never through ~ or $HOME, which a launcher redirects, nor a redirected DEV3_HOME", async () => {
		const originalHome = process.env.HOME;
		process.env.HOME = "/launcher/private/home";
		try {
			await setupAgentHooks(worktree, "agy");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
		const commands = Object.values(readJson(join(worktree, ".agents", "hooks.json")).dev3 as Record<string, Array<{ command: string }>>)
			.flatMap((handlers) => handlers.map((handler) => handler.command));
		expect(commands).toHaveLength(3);
		for (const command of commands) {
			expect(command).toContain(`exec ${userInfo().homedir}/.dev3.0/bin/dev3 hook agy `);
			expect(command).not.toContain("~");
			expect(command).not.toContain("/launcher/private/home");
			expect(command).not.toContain(tempHome);
		}
	});

	it("resolves a wrapper through its declared family", async () => {
		await setupAgentHooks(worktree, "ant", { family: "agy" });
		expect(existsSync(join(worktree, ".agents", "hooks.json"))).toBe(true);
	});

	it("keeps another skill the user has under .agents/skills", async () => {
		mkdirSync(join(worktree, ".agents", "skills", "mine"), { recursive: true });
		writeFileSync(join(worktree, ".agents", "skills", "mine", "SKILL.md"), "mine");
		await setupAgentHooks(worktree, "agy");
		expect(readFileSync(join(worktree, ".agents", "skills", "mine", "SKILL.md"), "utf-8")).toBe("mine");
	});

	it("writes nothing in a folder dev3 does not own", async () => {
		const folder = mkdtempSync(join(tmpdir(), "dev3-agy-user-folder-"));
		try {
			expect(await setupAgentHooks(folder, "agy")).toBeNull();
			expect(existsSync(join(folder, ".agents"))).toBe(false);
			expect(excludeTaskAgyConfig).not.toHaveBeenCalled();
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("skips the skill, not the hooks, when only the skill path is a symlink", async () => {
		const outside = mkdtempSync(join(tmpdir(), "dev3-agy-outside-"));
		try {
			mkdirSync(join(worktree, ".agents", "skills"), { recursive: true });
			symlinkSync(outside, join(worktree, ".agents", "skills", "dev3"));
			await setupAgentHooks(worktree, "agy");
			expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
			expect(existsSync(join(worktree, ".agents", "hooks.json"))).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("setupAgentHooks for agy in a repo that tracks the config", () => {
	const git = (cmd: string) => execSync(cmd, { cwd: worktree, stdio: "pipe", env: { ...process.env, ...GIT_CONFIG_ISOLATION, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });
	const MINE = JSON.stringify({ mine: { Stop: [{ type: "command", command: "echo done" }] } });

	function track(file: string, body: string): void {
		mkdirSync(join(worktree, file, ".."), { recursive: true });
		writeFileSync(join(worktree, file), body);
		git(`git add ${file}`);
		git("git commit -q -m tracked");
	}

	beforeEach(() => {
		git("git init -q -b main");
	});

	it("leaves a tracked hooks.json exactly as it is and writes no hooks for the task", async () => {
		track(".agents/hooks.json", MINE);

		await setupAgentHooks(worktree, "agy");

		expect(readFileSync(join(worktree, ".agents", "hooks.json"), "utf-8")).toBe(MINE);
		expect(git("git status --porcelain").toString()).not.toContain("hooks.json");
		expect(excludeTaskAgyConfig).toHaveBeenCalledWith(worktree);
	});

	it("still writes the skill when only the hooks file is tracked", async () => {
		track(".agents/hooks.json", MINE);
		await setupAgentHooks(worktree, "agy");
		expect(existsSync(join(worktree, ".agents", "skills", "dev3", "SKILL.md"))).toBe(true);
	});

	it("leaves a tracked dev3 skill alone and still writes the hooks", async () => {
		track(".agents/skills/dev3/SKILL.md", "the team's own skill\n");

		await setupAgentHooks(worktree, "agy");

		expect(readFileSync(join(worktree, ".agents", "skills", "dev3", "SKILL.md"), "utf-8")).toBe("the team's own skill\n");
		expect(readJson(join(worktree, ".agents", "hooks.json")).dev3).toBeDefined();
	});

	it("keeps merging into an UNTRACKED hooks.json that already exists", async () => {
		mkdirSync(join(worktree, ".agents"), { recursive: true });
		writeFileSync(join(worktree, ".agents", "hooks.json"), MINE);

		await setupAgentHooks(worktree, "agy");

		const after = readJson(join(worktree, ".agents", "hooks.json"));
		expect(after.mine).toEqual(JSON.parse(MINE).mine);
		expect(after.dev3.SessionStart).toBeDefined();
	});
});
