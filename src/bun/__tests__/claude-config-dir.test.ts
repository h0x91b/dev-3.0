import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeConfigLocation, launchClaudeConfigLocation, pinnedClaudeConfigDir } from "../../shared/claude-config-dir";
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

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "dev3-claude-dir-"));
		worktree = join(home, "wt");
		mkdirSync(worktree);
		vi.resetModules();
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
		remember.mockReset();
		vi.doMock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), homedir: () => home }));
		vi.doMock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
		// test-setup stubs Bun.write as a no-op; trust entries must really land on disk here.
		vi.spyOn((globalThis as any).Bun, "write").mockImplementation(async (path: unknown, content: unknown) => {
			mkdirSync(dirname(String(path)), { recursive: true });
			writeFileSync(String(path), String(content));
			return String(content).length;
		});
		vi.doMock("../claude-config-dirs", () => ({ rememberPinnedClaudeConfigDir: remember }));
		vi.doMock("../agent-accounts", async (importOriginal) => ({
			...(await importOriginal<typeof import("../agent-accounts")>()),
			getActiveClaudeConfigDir: vi.fn(async () => null),
			listClaudeAccountDirs: vi.fn(() => []),
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.doUnmock("node:os");
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

	it("installs the dev3 skills into a pinned dir at launch, and leaves the default dir to startup", async () => {
		const pinned = join(home, "pinned");
		const { ensureClaudeConfigDir } = await import("../agents");
		ensureClaudeConfigDir({ CLAUDE_CONFIG_DIR: pinned }, worktree);
		ensureClaudeConfigDir({}, worktree);

		expect(existsSync(join(pinned, "skills/dev3-project-config/SKILL.md"))).toBe(true);
		expect(existsSync(join(pinned, "settings.json"))).toBe(true);
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});
});
