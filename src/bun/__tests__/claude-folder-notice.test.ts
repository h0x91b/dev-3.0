import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
import { claudeFolderLabel } from "../../shared/claude-folder-notice";

const { resolveProjectEnv, loadSettings, loadProjects, loadTasks } = vi.hoisted(() => ({
	resolveProjectEnv: vi.fn(),
	loadSettings: vi.fn(),
	loadProjects: vi.fn(),
	loadTasks: vi.fn(),
}));
vi.mock("../repo-config", () => ({ resolveProjectEnv }));
vi.mock("../settings", () => ({ loadSettings }));
vi.mock("../data", () => ({ loadProjects, loadTasks }));

import {
	claudeFolderHasLogin,
	claudeFolderNotice,
	claudeFolderSwitchImpact,
	claudeKeychainAccount,
	claudeKeychainService,
	type LoginProbe,
} from "../claude-folder-notice";

const project = { id: "p1", name: "web", path: "/work/web" } as Project;

function probe(over: Partial<LoginProbe> = {}): LoginProbe {
	return { platform: "linux", fileExists: () => false, keychainHasItem: async () => false, loginKeptOutOfGit: () => true, ...over };
}

beforeEach(() => {
	resolveProjectEnv.mockReset();
	loadSettings.mockReset().mockResolvedValue({});
	loadProjects.mockReset();
	loadTasks.mockReset();
});

describe("claudeKeychainService", () => {
	it("suffixes the first 8 hex chars of sha256 over the exact CLAUDE_CONFIG_DIR value", () => {
		expect(claudeKeychainService("/Users/me/repo/.claude")).toBe("Claude Code-credentials-104e7cbd");
	});
	it("hashes the NFC form, as Claude Code does", () => {
		expect(claudeKeychainService("/Users/me/répo/.claude")).toBe("Claude Code-credentials-e2bea24f");
	});
});

describe("claudeKeychainAccount", () => {
	it("uses $USER, and a fixed name when $USER has characters Claude Code rejects", () => {
		expect(claudeKeychainAccount({ USER: "me.dev" })).toBe("me.dev");
		expect(claudeKeychainAccount({ USER: "me dev" })).toBe("claude-code-user");
	});
});

describe("claudeFolderHasLogin", () => {
	it("finds the login file on any OS", async () => {
		const fileExists = vi.fn((file: string) => file === "/work/web/.claude/.credentials.json");
		expect(await claudeFolderHasLogin("/work/web/.claude", "/work/web/.claude", probe({ fileExists }))).toBe(true);
	});
	it("asks the Keychain for the hashed service only on macOS", async () => {
		const keychainHasItem = vi.fn(async () => true);
		expect(await claudeFolderHasLogin("/w/.claude", "/w/.claude", probe({ keychainHasItem }))).toBe(false);
		expect(keychainHasItem).not.toHaveBeenCalled();
		expect(await claudeFolderHasLogin("/w/.claude", "/w/.claude", probe({ platform: "darwin", keychainHasItem }))).toBe(true);
		expect(keychainHasItem).toHaveBeenCalledWith(claudeKeychainService("/w/.claude"));
	});
});

describe("claudeFolderNotice", () => {
	it("reports a pinned folder without a login as no-login, and with one as ready", async () => {
		resolveProjectEnv.mockResolvedValue({ CLAUDE_CONFIG_DIR: "/work/web/.claude" });
		expect(await claudeFolderNotice(project, probe())).toEqual({ state: "no-login", dir: "/work/web/.claude" });
		expect(await claudeFolderNotice(project, probe({ fileExists: () => true }))).toEqual({ state: "ready", dir: "/work/web/.claude" });
	});

	it("reports a pin git would not ignore as refused off macOS, as the launch drops it", async () => {
		resolveProjectEnv.mockResolvedValue({ CLAUDE_CONFIG_DIR: "/work/web/.claude" });
		const loginKeptOutOfGit = vi.fn(() => false);
		expect(await claudeFolderNotice(project, probe({ loginKeptOutOfGit }))).toEqual({ state: "refused", dir: "/work/web/.claude" });
		expect(loginKeptOutOfGit).toHaveBeenCalledWith("/work/web/.claude");
		expect(await claudeFolderNotice(project, probe({ platform: "darwin", loginKeptOutOfGit }))).toEqual({ state: "no-login", dir: "/work/web/.claude" });
	});

	it("says nothing when agents use ~/.claude and no project-folder default applies", async () => {
		resolveProjectEnv.mockResolvedValue({});
		expect(await claudeFolderNotice(project, probe())).toBeNull();
		resolveProjectEnv.mockResolvedValue({ CLAUDE_CONFIG_DIR: `${homedir()}/.claude` });
		expect(await claudeFolderNotice(project, probe())).toBeNull();
	});

	it("reports a refused project-folder default with the folder that was refused", async () => {
		resolveProjectEnv.mockResolvedValue({});
		loadSettings.mockResolvedValue({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude/" } });
		expect(await claudeFolderNotice(project, probe())).toEqual({ state: "refused", dir: "/work/web/.claude" });
	});

	it("does not call a project's own cleared value a refusal", async () => {
		resolveProjectEnv.mockResolvedValue({ CLAUDE_CONFIG_DIR: "" });
		loadSettings.mockResolvedValue({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude" } });
		expect(await claudeFolderNotice(project, probe())).toBeNull();
	});

	it("skips Operations boards and never throws", async () => {
		expect(await claudeFolderNotice({ ...project, kind: "virtual" } as Project, probe())).toBeNull();
		resolveProjectEnv.mockRejectedValue(new Error("boom"));
		expect(await claudeFolderNotice(project, probe())).toBeNull();
	});
});

describe("claudeFolderSwitchImpact", () => {
	const other = { id: "p2", name: "api", path: "/work/api" } as Project;
	const tasks = (...statuses: string[]) => statuses.map((status) => ({ status }) as Task);

	it("counts active tasks only in projects whose folder the switch changes", async () => {
		loadProjects.mockResolvedValue([project, other]);
		// `web` follows the default; `api` pins its own folder, so the switch leaves it alone.
		resolveProjectEnv.mockImplementation(async (p: Project, _wt?: unknown, opts?: { agentEnvDefaults?: Record<string, string> }) => {
			if (p.id === "p2") return { CLAUDE_CONFIG_DIR: "/elsewhere/.claude" };
			return opts && "agentEnvDefaults" in opts && opts.agentEnvDefaults?.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: "/work/web/.claude" } : {};
		});
		loadTasks.mockImplementation(async (p: Project) => (p.id === "p1" ? tasks("in-progress", "review-by-user", "completed", "todo") : tasks("in-progress")));
		expect(await claudeFolderSwitchImpact(true)).toEqual({ taskCount: 2, projectNames: ["web"] });
		expect(resolveProjectEnv).toHaveBeenCalledWith(project, null, { agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude" } });
	});

	it("reports nothing when no project changes folder", async () => {
		loadProjects.mockResolvedValue([project]);
		resolveProjectEnv.mockResolvedValue({});
		expect(await claudeFolderSwitchImpact(true)).toEqual({ taskCount: 0, projectNames: [] });
		expect(loadTasks).not.toHaveBeenCalled();
	});
});

describe("claudeFolderLabel", () => {
	it("names a folder inside the project by the project's name", () => {
		expect(claudeFolderLabel("/work/web/.claude", project)).toBe("web/.claude");
		expect(claudeFolderLabel("C:\\src\\web\\.claude", { name: "web", path: "C:\\src\\web\\" })).toBe("web\\.claude");
	});
	it("keeps the full path for a folder outside the project, including a sibling sharing its prefix", () => {
		expect(claudeFolderLabel("/work/web2/.claude", project)).toBe("/work/web2/.claude");
		expect(claudeFolderLabel("/elsewhere/.claude", project)).toBe("/elsewhere/.claude");
	});
});
