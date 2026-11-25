import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync as spawnSyncNode } from "node:child_process";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeConfigLocation, launchClaudeConfigLocation, normalizeClaudeConfigDir, pinnedClaudeConfigDir } from "../../shared/claude-config-dir";
import { ENV_UNSET } from "../../shared/agent-accounts";

describe("pinnedClaudeConfigDir", () => {
	const home = "/home/me";
	it("expands ~ and drops trailing slashes", () => {
		expect(pinnedClaudeConfigDir("~/proj/.claude/", home)).toBe("/home/me/proj/.claude");
		expect(pinnedClaudeConfigDir(" /work/x/.claude// ", home)).toBe("/work/x/.claude");
	});
	it("resolves a relative pin against cwd, as claudeConfigLocation does", () => {
		expect(pinnedClaudeConfigDir(".claude", home, "/work/x")).toBe("/work/x/.claude");
	});
	it("treats unset, blank, the switcher's unset sentinel and ~/.claude as the system login", () => {
		expect(pinnedClaudeConfigDir(undefined, home)).toBeNull();
		expect(pinnedClaudeConfigDir("  ", home)).toBeNull();
		expect(pinnedClaudeConfigDir(ENV_UNSET, home)).toBeNull();
		expect(pinnedClaudeConfigDir("~/.claude", home)).toBeNull();
		expect(pinnedClaudeConfigDir("/home/me/.claude/", home)).toBeNull();
	});
});

describe("normalizeClaudeConfigDir with Windows paths", () => {
	const home = "C:\\Users\\me";
	it("gives a {projectPath} expansion with mixed separators one backslash spelling", () => {
		expect(normalizeClaudeConfigDir("C:\\src\\acme/.claude/", home, undefined, win32)).toBe("C:\\src\\acme\\.claude");
		expect(normalizeClaudeConfigDir("C:/src/acme/.claude", home, undefined, win32)).toBe("C:\\src\\acme\\.claude");
	});
	it("expands ~ with either separator and resolves a relative value against a drive-letter cwd", () => {
		expect(normalizeClaudeConfigDir("~\\proj\\.claude", home, undefined, win32)).toBe("C:\\Users\\me\\proj\\.claude");
		expect(normalizeClaudeConfigDir("~/proj/.claude", home, undefined, win32)).toBe("C:\\Users\\me\\proj\\.claude");
		expect(normalizeClaudeConfigDir(".claude", home, "D:\\wt\\task", win32)).toBe("D:\\wt\\task\\.claude");
	});
	it("keeps a drive root intact", () => {
		expect(normalizeClaudeConfigDir("C:\\", home, undefined, win32)).toBe("C:\\");
	});
});

describe("claudeConfigLocation", () => {
	it("falls back to ~/.claude and ~/.claude.json when nothing pins a dir", () => {
		expect(claudeConfigLocation({}, "/home/u")).toEqual({
			dir: "/home/u/.claude",
			claudeJson: "/home/u/.claude.json",
			pinned: false,
		});
	});

	it("keeps every file inside CLAUDE_CONFIG_DIR when it is set", () => {
		expect(claudeConfigLocation({ CLAUDE_CONFIG_DIR: " /p/.claude " }, "/home/u")).toEqual({
			dir: "/p/.claude",
			claudeJson: "/p/.claude/.claude.json",
			pinned: true,
		});
	});

	it("expands ~ and drops trailing slashes so one dir has one spelling", () => {
		expect(claudeConfigLocation({ CLAUDE_CONFIG_DIR: "~/proj/.claude/" }, "/home/u").dir).toBe("/home/u/proj/.claude");
	});

	it("resolves a relative value against the agent's cwd, not the server's", () => {
		expect(claudeConfigLocation({ CLAUDE_CONFIG_DIR: ".claude-cfg/" }, "/home/u", "/wt/task").dir).toBe("/wt/task/.claude-cfg");
		expect(claudeConfigLocation({ CLAUDE_CONFIG_DIR: "/abs/cfg" }, "/home/u", "/wt/task").dir).toBe("/abs/cfg");
	});

	it("treats a blank value as unset", () => {
		expect(claudeConfigLocation({ CLAUDE_CONFIG_DIR: "  " }, "/home/u").pinned).toBe(false);
	});
});

describe("launchClaudeConfigLocation", () => {
	it("lets the launch env win over the server's own env", () => {
		expect(launchClaudeConfigLocation({ CLAUDE_CONFIG_DIR: "/proj" }, { CLAUDE_CONFIG_DIR: "/server" }, "/h").dir).toBe("/proj");
	});

	it("inherits the server's dir when the launch sets none", () => {
		expect(launchClaudeConfigLocation({}, { CLAUDE_CONFIG_DIR: "/server" }, "/h").dir).toBe("/server");
		expect(launchClaudeConfigLocation(undefined, {}, "/h").dir).toBe("/h/.claude");
	});

	it("reads the account switcher's unset sentinel as the default dir, not a path or the server's pin", () => {
		const location = launchClaudeConfigLocation({ CLAUDE_CONFIG_DIR: ENV_UNSET }, { CLAUDE_CONFIG_DIR: "/server" }, "/h");
		expect(location).toEqual({ dir: "/h/.claude", claudeJson: "/h/.claude.json", pinned: false });
	});
});

describe("ensureClaudeTrust / ensureClaudeConfigDir with a pinned dir", () => {
	let home = "";
	let worktree = "";
	const remember = vi.fn();
	let accountDirs: string[] = [];

	beforeEach(() => {
		accountDirs = [];
		home = mkdtempSync(join(tmpdir(), "dev3-claude-dir-"));
		worktree = join(home, "wt");
		mkdirSync(worktree);
		vi.resetModules();
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
		remember.mockReset();
		vi.doMock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), homedir: () => home }));
		vi.doMock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
		vi.doMock("../claude-config-dirs", () => ({ rememberPinnedClaudeConfigDir: remember }));
		vi.doMock("../agent-accounts", async (importOriginal) => ({
			...(await importOriginal<typeof import("../agent-accounts")>()),
			getActiveClaudeConfigDir: vi.fn(async () => null),
			listClaudeAccountDirs: vi.fn(() => accountDirs),
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.doUnmock("node:os");
		vi.doUnmock("../spawn");
		rmSync(home, { recursive: true, force: true });
	});

	it("writes trust into the pinned dir's .claude.json and never into ~/.claude.json", async () => {
		const pinned = join(home, "pinned");
		const { ensureClaudeTrust } = await import("../agents");
		await ensureClaudeTrust(worktree, undefined, undefined, { CLAUDE_CONFIG_DIR: pinned });

		const data = JSON.parse(readFileSync(join(pinned, ".claude.json"), "utf-8"));
		expect(data.projects[realpathSync(worktree)].hasTrustDialogAccepted).toBe(true);
		expect(existsSync(join(home, ".claude.json"))).toBe(false);
		expect(remember).toHaveBeenCalledWith(pinned);
	});

	it("puts a relative pin's trust and skills inside the worktree the agent runs in", async () => {
		const { ensureClaudeTrust, ensureClaudeConfigDir } = await import("../agents");
		await ensureClaudeTrust(worktree, undefined, undefined, { CLAUDE_CONFIG_DIR: "cfg" });
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: "cfg" }, worktree);

		const data = JSON.parse(readFileSync(join(worktree, "cfg/.claude.json"), "utf-8"));
		expect(data.projects[realpathSync(worktree)].hasTrustDialogAccepted).toBe(true);
		expect(existsSync(join(worktree, "cfg/skills/dev3/SKILL.md"))).toBe(true);
		expect(remember).toHaveBeenCalledWith(join(worktree, "cfg"));
	});

	it("keeps using ~/.claude.json when nothing pins a dir", async () => {
		const { ensureClaudeTrust } = await import("../agents");
		await ensureClaudeTrust(worktree, undefined, undefined, {});

		expect(existsSync(join(home, ".claude.json"))).toBe(true);
		expect(remember).not.toHaveBeenCalled();
	});

	it("provisions a linked account slot at launch but skips a managed account's", async () => {
		const target = join(home, "target");
		const external = join(home, "slot-external");
		const managed = join(home, "slot-managed");
		mkdirSync(target);
		mkdirSync(managed);
		symlinkSync(target, external, "dir");
		// One mock per module: a second doMock of the same path races the first one's async factory.
		accountDirs = [external, managed];
		const { ensureClaudeConfigDir } = await import("../agents");
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: external }, worktree);
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: managed }, worktree);

		expect(existsSync(join(target, "skills/dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(target, "settings.json"))).toBe(true);
		expect(existsSync(join(managed, "skills"))).toBe(false);
	});

	it("installs the dev3 skills into a pinned dir at launch, and leaves the default dir to startup", async () => {
		const pinned = join(home, "pinned");
		const { ensureClaudeConfigDir } = await import("../agents");
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: pinned }, worktree);
		ensureClaudeConfigDir({}, worktree);

		expect(existsSync(join(pinned, "skills/dev3-project-config/SKILL.md"))).toBe(true);
		expect(existsSync(join(pinned, "settings.json"))).toBe(true);
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	it("leaves a committed settings.json alone, patches the task's local settings and hides runtime state from git", async () => {
		const project = join(home, "project");
		const pinned = join(project, ".claude");
		mkdirSync(pinned, { recursive: true });
		const committed = `${JSON.stringify({ permissions: { allow: ["Bash(ls *)"] } }, null, 2)}\n`;
		writeFileSync(join(pinned, "settings.json"), committed);
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project });
		git("init", "-q");
		git("add", ".claude/settings.json");
		git("commit", "-qm", "init");
		vi.stubEnv("DEV3_HOME", join(home, ".dev3.0"));
		const taskDir = join(home, ".dev3.0", "worktrees", "p", "wt");
		mkdirSync(taskDir, { recursive: true });

		// The suite stubs Bun.spawnSync; this test needs real git answers.
		vi.doMock("../spawn", async (importOriginal) => ({
			...(await importOriginal<typeof import("../spawn")>()),
			spawnSync: (cmd: string[], opts: { cwd: string }) => {
				const res = spawnSyncNode(cmd[0], cmd.slice(1), { cwd: opts.cwd });
				return { exitCode: res.status, stdout: res.stdout };
			},
		}));

		const { ensureClaudeConfigDir } = await import("../agents");
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: pinned }, taskDir);

		expect(readFileSync(join(pinned, "settings.json"), "utf-8")).toBe(committed);
		const local = JSON.parse(readFileSync(join(taskDir, ".claude/settings.local.json"), "utf-8"));
		expect(local.sandbox.network.allowUnixSockets).toContain(`${home}/.dev3.0/sockets`);
		expect(existsSync(join(pinned, "skills/dev3/SKILL.md"))).toBe(true);
		writeFileSync(join(pinned, ".claude.json"), "{}");
		expect(git("status", "--porcelain").toString()).toBe("");
	});

	describe("off macOS, a pin whose login git would not ignore after provisioning", () => {
		let project = "";
		let pinned = "";
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project });

		beforeEach(() => {
			project = join(home, "project");
			pinned = join(project, ".claude");
			mkdirSync(project);
			git("init", "-q");
			vi.stubEnv("DEV3_HOME", join(home, ".dev3.0"));
			// The suite stubs Bun.spawnSync; these tests need real git answers.
			vi.doMock("../spawn", async (importOriginal) => ({
				...(await importOriginal<typeof import("../spawn")>()),
				spawnSync: (cmd: string[], opts: { cwd: string; env?: Record<string, string> }) => {
					const res = spawnSyncNode(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
					return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr };
				},
			}));
		});

		it("keeps the pin once the launch's exclude rule hides the login", async () => {
			const env = { CLAUDE_CONFIG_DIR: pinned };
			const { ensureClaudeConfigDir } = await import("../agents");
			ensureClaudeConfigDir(env, project, "linux");

			expect(env.CLAUDE_CONFIG_DIR).toBe(pinned);
			writeFileSync(join(pinned, ".credentials.json"), "{}");
			expect(git("status", "--porcelain", "--", ".claude/.credentials.json").toString()).toBe("");
		});

		it("clears the pin when a .gitignore negation keeps the login visible, but not on macOS", async () => {
			writeFileSync(join(project, ".gitignore"), "!.claude/.credentials.json\n");
			const { ensureClaudeConfigDir } = await import("../agents");
			const linux = { CLAUDE_CONFIG_DIR: pinned };
			ensureClaudeConfigDir(linux, project, "linux");
			const darwin = { CLAUDE_CONFIG_DIR: pinned };
			ensureClaudeConfigDir(darwin, project, "darwin");

			expect(linux.CLAUDE_CONFIG_DIR).toBe(ENV_UNSET);
			expect(darwin.CLAUDE_CONFIG_DIR).toBe(pinned);
		});

		it.skipIf(process.getuid?.() === 0)("clears the pin when the exclude write fails, and writes it on the next launch", async () => {
			const info = join(project, ".git", "info");
			const exclude = join(info, "exclude");
			const original = readFileSync(exclude, "utf-8");
			chmodSync(exclude, 0o400);
			const { ensureClaudeConfigDir } = await import("../agents");
			const first = { CLAUDE_CONFIG_DIR: pinned };
			ensureClaudeConfigDir(first, project, "linux");
			expect(readFileSync(exclude, "utf-8")).toBe(original);
			expect(first.CLAUDE_CONFIG_DIR).toBe(ENV_UNSET);

			chmodSync(exclude, 0o600);
			const second = { CLAUDE_CONFIG_DIR: pinned };
			ensureClaudeConfigDir(second, project, "linux");
			expect(readFileSync(exclude, "utf-8")).toContain(".credentials.json");
			expect(second.CLAUDE_CONFIG_DIR).toBe(pinned);
		});
	});
});

describe("projectClaudeConfigDirAllowed", () => {
	let root = "";
	let project = "";
	const spawned = vi.fn();
	let gitCannotRun = false;
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-claude-allowed-"));
		project = join(root, "project");
		mkdirSync(project);
		spawned.mockReset();
		gitCannotRun = false;
		vi.resetModules();
		vi.doMock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
		// The suite stubs Bun.spawnSync; these tests need real git answers. One mock per module:
		// a second doMock of the same path races the first one's async factory, so tests flip a flag.
		vi.doMock("../spawn", async (importOriginal) => ({
			...(await importOriginal<typeof import("../spawn")>()),
			spawnSync: (cmd: string[], opts: { cwd: string; env?: Record<string, string> }) => {
				spawned(cmd);
				if (gitCannotRun) throw new Error('Executable not found in $PATH: "git"');
				const res = spawnSyncNode(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
				return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr };
			},
		}));
	});

	afterEach(() => {
		vi.doUnmock("../spawn");
		vi.doUnmock("../logger");
		rmSync(root, { recursive: true, force: true });
	});

	async function allowed(value: string, platform: string, kind?: "git" | "virtual") {
		const { projectClaudeConfigDirAllowed } = await import("../claude-config-git");
		return projectClaudeConfigDirAllowed({ path: project, kind }, value, platform);
	}

	it("allows a project's .claude on Linux before it exists, and changes nothing in the repo", async () => {
		git("init", "-q");
		const exclude = readFileSync(join(project, ".git", "info", "exclude"), "utf-8");
		expect(await allowed(join(project, ".claude"), "linux")).toBe(true);
		expect(existsSync(join(project, ".claude"))).toBe(false);
		expect(readFileSync(join(project, ".git", "info", "exclude"), "utf-8")).toBe(exclude);
	});

	it("refuses it on Linux and Windows when the login file is tracked or un-ignored", async () => {
		mkdirSync(join(project, ".claude"));
		writeFileSync(join(project, ".claude", ".credentials.json"), "{}");
		git("init", "-q");
		git("add", ".claude/.credentials.json");
		git("commit", "-qm", "init");
		expect(await allowed(join(project, ".claude"), "linux")).toBe(false);
		expect(await allowed(join(project, ".claude"), "win32")).toBe(false);
		expect(await allowed(join(project, ".claude"), "darwin")).toBe(true);

		git("rm", "-q", "--cached", ".claude/.credentials.json");
		writeFileSync(join(project, ".gitignore"), "!.claude/.credentials.json\n");
		expect(await allowed(join(project, ".claude"), "linux")).toBe(false);
	});

	it("allows it where no git repo holds it, including behind a symlink out of the repo", async () => {
		expect(await allowed(join(project, ".claude"), "linux")).toBe(true);
		git("init", "-q");
		const shared = join(root, "shared-claude");
		mkdirSync(shared);
		symlinkSync(shared, join(project, ".claude"));
		expect(await allowed(join(project, ".claude"), "linux")).toBe(true);
	});

	it("never applies to an Operations board", async () => {
		git("init", "-q");
		expect(await allowed(join(project, ".claude"), "darwin", "virtual")).toBe(false);
		expect(await allowed(join(project, ".claude"), "linux", "virtual")).toBe(false);
	});

	it("refuses instead of throwing when git cannot run", async () => {
		gitCannotRun = true;
		expect(await allowed(join(project, ".claude"), "linux")).toBe(false);
		expect(spawned).toHaveBeenCalled();
	});
});
