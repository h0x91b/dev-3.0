import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_UNSET } from "../../shared/agent-accounts";
import {
	claudeDumpFilePaths,
	claudeDumpOwner,
	configDirDumpName,
	resolveOriginalStatusLine,
	sessionDumpFilePath,
	STATUSLINE_NESTED_ENV,
	statusLineAccountLabel,
} from "../commands/statusline";

let tmp: string;
let projectDir: string;
let home: string;

function writeSettings(path: string, statusLine: unknown): void {
	mkdirSync(join(path, ".claude"), { recursive: true });
	writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify({ statusLine }));
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dev3-sl-test-"));
	projectDir = join(tmp, "project");
	home = join(tmp, "home");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("resolveOriginalStatusLine", () => {
	it("returns null when no settings file defines a statusLine", () => {
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it("finds the user-level statusLine in ~/.claude/settings.json", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo user" });
	});

	it("prefers project settings.local.json over project settings.json over user settings", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		writeSettings(projectDir, { type: "command", command: "echo project" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo project" });

		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.local.json"),
			JSON.stringify({ statusLine: { type: "command", command: "echo local" } }),
		);
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo local" });
	});

	it.each([
		'"/Users/x/.dev3.0/bin/dev3" statusline',
		"dev3 statusline",
		"~/.dev3.0/bin/dev3 statusline | cat",
		"exec dev3 statusline agy",
		'"C:\\Users\\x\\.dev3.0\\bin\\dev3" statusline',
		"dev3.cmd statusline",
		"(dev3 statusline)",
		'dev3 "statusline"',
		"DEV3.EXE statusline",
		"Dev3.cmd statusline",
		"$(which dev3) statusline",
		"`which dev3` statusline",
		"true; dev3 statusline",
		"x=1 && dev3 statusline",
	])("skips a statusLine that points back at dev3 statusline (recursion guard): %s", (command) => {
		writeSettings(home, { type: "command", command });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it.each([
		"~/.dev3.0/bin/my-statusline.sh",
		"bash /Users/x/.dev3.0/statusline.sh",
		"~/scripts/dev3-statusline.sh",
		"node ~/dev3/tools/statusline.js",
		"mydev3 statusline",
		"dev3 statusline-custom.sh",
	])("keeps a user statusLine that only mentions dev3 and statusline: %s", (command) => {
		writeSettings(home, { type: "command", command });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command });
	});

	it("skips corrupt settings files and falls through to the next level", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(join(projectDir, ".claude", "settings.json"), "{not json");
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo user" });
	});

	it("ignores non-command statusLine shapes and blank commands", () => {
		writeSettings(home, { type: "static", text: "hi" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
		writeSettings(home, { type: "command", command: "   " });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it("reads user-level settings from CLAUDE_CONFIG_DIR instead of ~/.claude when it is set", () => {
		const configDir = join(tmp, "config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo config" } }));
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, configDir)).toEqual({ command: "echo config" });
	});

	it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is blank", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, "  ")).toEqual({ command: "echo user" });
	});

	it("works with a null projectDir (user settings only)", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(null, home, undefined)).toEqual({ command: "echo user" });
	});
});

describe("handleStatusLine nesting guard (subprocess)", () => {
	// vitest runs under node; the CLI is TS importing project source, so run it with bun.
	const BUN = /(?:^|\/)bun$/.test(process.execPath) ? process.execPath : "bun";
	const MAIN = resolve(import.meta.dirname, "../main.ts");

	/** A user statusLine wrapper script — invisible to the command-string check — that logs each
	 *  run and then calls `dev3 statusline` itself, so only the env guard can stop the recursion. */
	function runWithWrapper(extraEnv: Record<string, string>): { stdout: string; runs: number } {
		const calls = join(tmp, "calls.log");
		const wrapper = join(tmp, "dev3-statusline.sh");
		writeFileSync(wrapper, `echo run >> ${JSON.stringify(calls)}\necho wrapped\nexec ${JSON.stringify(BUN)} ${JSON.stringify(MAIN)} statusline\n`);
		writeSettings(home, { type: "command", command: `bash ${JSON.stringify(wrapper)}` });
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, DEV3_HOME: join(tmp, ".dev3.0"), CLAUDE_CONFIG_DIR: "", DEV3_TASK_ID: "", ...extraEnv };
		if (!(STATUSLINE_NESTED_ENV in extraEnv)) delete env[STATUSLINE_NESTED_ENV];
		const result = spawnSync(BUN, [MAIN, "statusline"], {
			input: JSON.stringify({ workspace: { current_dir: projectDir } }),
			env,
			encoding: "utf-8",
			timeout: 15_000,
		});
		const runs = existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n").length : 0;
		return { stdout: result.stdout ?? "", runs };
	}

	it("runs the user's wrapper once; the dev3 statusline inside it does not delegate again", () => {
		const { stdout, runs } = runWithWrapper({});
		expect(stdout).toContain("wrapped");
		expect(runs).toBe(1);
	}, 20_000);

	it("skips delegation entirely when the nesting variable is already set", () => {
		const { stdout, runs } = runWithWrapper({ [STATUSLINE_NESTED_ENV]: "1" });
		expect(stdout).not.toContain("wrapped");
		expect(runs).toBe(0);
	}, 20_000);
});

describe("claudeDumpFilePaths", () => {
	const base = "/base";

	it("writes the system login (no managed id) to the shared claude.json", () => {
		expect(claudeDumpFilePaths(null, base)).toEqual([join(base, "claude.json")]);
	});

	it("writes a managed account to its own per-account file only (never claude.json)", () => {
		const paths = claudeDumpFilePaths("acc-123", base);
		expect(paths).toEqual([join(base, "claude", "acc-123.json")]);
		expect(paths).not.toContain(join(base, "claude.json"));
	});

	it("writes a project-pinned config dir to its own per-dir file, never claude.json", () => {
		const paths = claudeDumpFilePaths(null, base, "/work/proj/.claude");
		expect(paths).toEqual([join(base, "claude-config-dirs", `${configDirDumpName("/work/proj/.claude")}.json`)]);
	});

	it("lets a managed account id win over a config dir", () => {
		expect(claudeDumpFilePaths("acc-123", base, "/work/proj/.claude")).toEqual([join(base, "claude", "acc-123.json")]);
	});

	it("names each config dir stably and distinctly", () => {
		expect(configDirDumpName("/a/.claude")).toBe(configDirDumpName("/a/.claude"));
		expect(configDirDumpName("/a/.claude")).not.toBe(configDirDumpName("/b/.claude"));
		expect(configDirDumpName("/a/.claude")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("sessionDumpFilePath", () => {
	it("writes one dump per dev3 task under sessions/", () => {
		expect(sessionDumpFilePath("9994e79b-4c1b", "/base")).toBe(join("/base", "sessions", "9994e79b-4c1b.json"));
	});

	it("writes nothing outside a task or for an unsafe id", () => {
		expect(sessionDumpFilePath(undefined, "/base")).toBeNull();
		expect(sessionDumpFilePath("  ", "/base")).toBeNull();
		expect(sessionDumpFilePath("../escape", "/base")).toBeNull();
	});
});

describe("claudeDumpOwner", () => {
	const dev3Home = "/u/.dev3.0";
	const accountDir = (id: string) => `${dev3Home}/agent-accounts/claude/${id}`;
	const WIX = "790d55d8-70f4-4e55-b03e-a37e7c16e00b";
	const BASE44 = "43992250-2170-469a-a726-8688c56ad0bc";

	it("attributes usage to the account whose config dir Claude runs on, not a stale account id", () => {
		// A Claude teammate pane: Claude forwards CLAUDE_CONFIG_DIR, while the
		// account id comes from a tmux session created for the task's earlier account.
		const env = { CLAUDE_CONFIG_DIR: accountDir(BASE44), DEV3_AGENT_ACCOUNT_ID: WIX };
		expect(claudeDumpOwner(env, "/u", "/w", dev3Home)).toEqual({ accountId: BASE44, configDir: null });
	});

	it("reads a managed account from its config dir alone", () => {
		expect(claudeDumpOwner({ CLAUDE_CONFIG_DIR: `${accountDir(WIX)}/` }, "/u", "/w", dev3Home)).toEqual({
			accountId: WIX,
			configDir: null,
		});
	});

	it("treats a session on ~/.claude as the system login even when an account id leaked in", () => {
		expect(claudeDumpOwner({ DEV3_AGENT_ACCOUNT_ID: WIX }, "/u", "/w", dev3Home)).toEqual({ accountId: null, configDir: null });
		expect(claudeDumpOwner({ CLAUDE_CONFIG_DIR: ENV_UNSET, DEV3_AGENT_ACCOUNT_ID: WIX }, "/u", "/w", dev3Home)).toEqual({
			accountId: null,
			configDir: null,
		});
	});

	it("keeps a project-pinned dir as a config-dir login", () => {
		expect(claudeDumpOwner({ CLAUDE_CONFIG_DIR: "/work/proj/.claude", DEV3_AGENT_ACCOUNT_ID: WIX }, "/u", "/w", dev3Home)).toEqual({
			accountId: null,
			configDir: "/work/proj/.claude",
		});
	});

	it("does not read an account id out of a dir that only looks like an account slot", () => {
		const elsewhere = "/tmp/agent-accounts/claude/x";
		expect(claudeDumpOwner({ CLAUDE_CONFIG_DIR: elsewhere }, "/u", "/w", dev3Home)).toEqual({ accountId: null, configDir: elsewhere });
		const nested = `${accountDir(WIX)}/projects`;
		expect(claudeDumpOwner({ CLAUDE_CONFIG_DIR: nested }, "/u", "/w", dev3Home)).toEqual({ accountId: null, configDir: nested });
	});
});

describe("statusLineAccountLabel", () => {
	const id = "acct-1";
	let dev3Home: string;
	let accountDir: string;

	beforeEach(() => {
		dev3Home = join(tmp, ".dev3.0");
		accountDir = join(dev3Home, "agent-accounts", "claude", id);
		mkdirSync(accountDir, { recursive: true });
		writeFileSync(join(accountDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@work.test" } }));
	});

	const writeRegistry = (label: string) =>
		writeFileSync(
			join(dev3Home, "agent-accounts", "accounts.json"),
			JSON.stringify({ version: 1, claude: { activeId: null, accounts: [{ id, label }] } }),
		);

	it("prefers the managed account's label", () => {
		writeRegistry("work");
		expect(statusLineAccountLabel({ CLAUDE_CONFIG_DIR: accountDir }, home, tmp, dev3Home)).toBe("work");
	});

	it("falls back to the login's email when the label is blank or the registry is missing", () => {
		expect(statusLineAccountLabel({ CLAUDE_CONFIG_DIR: accountDir }, home, tmp, dev3Home)).toBe("me@work.test");
		writeRegistry("  ");
		expect(statusLineAccountLabel({ CLAUDE_CONFIG_DIR: accountDir }, home, tmp, dev3Home)).toBe("me@work.test");
	});

	it("reads the system login's email from ~/.claude.json", () => {
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@home.test" } }));
		expect(statusLineAccountLabel({}, home, tmp, dev3Home)).toBe("me@home.test");
	});

	it("strips control characters and returns null when nothing names the login", () => {
		writeRegistry("wo\u001b[31mrk\n");
		expect(statusLineAccountLabel({ CLAUDE_CONFIG_DIR: accountDir }, home, tmp, dev3Home)).toBe("wo[31mrk");
		expect(statusLineAccountLabel({}, home, tmp, dev3Home)).toBeNull();
	});
});
