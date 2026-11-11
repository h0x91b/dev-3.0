import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

const { resolveProjectEnv, loadSettings } = vi.hoisted(() => ({
	resolveProjectEnv: vi.fn(),
	loadSettings: vi.fn(),
}));
vi.mock("../repo-config", () => ({ resolveProjectEnv }));
vi.mock("../settings", () => ({ loadSettings }));

import {
	claudeFolderHasLogin,
	claudeFolderNotice,
	claudeKeychainAccount,
	claudeKeychainService,
	type LoginProbe,
} from "../claude-folder-notice";

const project = { id: "p1", name: "web", path: "/work/web" } as Project;

function probe(over: Partial<LoginProbe> = {}): LoginProbe {
	return { platform: "linux", fileExists: () => false, keychainHasItem: async () => false, ...over };
}

beforeEach(() => {
	resolveProjectEnv.mockReset();
	loadSettings.mockReset().mockResolvedValue({});
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

