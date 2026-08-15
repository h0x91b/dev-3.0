import { describe, expect, it } from "vitest";
import { load } from "js-toml";
import {
	buildDev3CodexHooksBlock,
	CODEX_HOOK_TRUST_BYPASS_FLAG,
	ensureCodexConfig,
	supportsCodexHookTrustBypass,
} from "../codex-config";
import { CODEX_STATUS_HOOK_EVENTS } from "../../shared/agent-hooks";

/**
 * Both dialects are PINNED. `buildCodexHooks` spells the CLI in the HOST's
 * dialect, so a fixture that inherits the ambient platform asserts something
 * different on the windows-latest runner than it does on macOS — which is
 * exactly how the previous attempt at this fix went red for a reason unrelated
 * to the code it was testing (Seq 1540).
 */
const POSIX_DIALECT = { cli: "/Users/user/.dev3.0/bin/dev3", posixShell: true };
const WINDOWS_DIALECT = {
	cli: '"C:\\Users\\user\\.dev3.0\\bin\\dev3.exe"',
	posixShell: false,
};

interface ParsedHooks {
	hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>>;
}

const parse = (toml: string) => load(toml) as ParsedHooks;

describe("the Codex hooks block dev3 writes into config.toml", () => {
	it("parses as TOML and declares every status event", () => {
		const parsed = parse(buildDev3CodexHooksBlock({ dialect: POSIX_DIALECT }));
		expect(Object.keys(parsed.hooks ?? {}).sort()).toEqual([...CODEX_STATUS_HOOK_EVENTS].sort());
		expect(parsed.hooks?.SessionStart?.[0]?.matcher).toBe("startup|resume");
	});

	it("carries a Windows CLI path back out byte-for-byte", () => {
		// The whole point of the file route. A raw `C:\Users` inside a TOML basic
		// string is the escape `\U`, which killed the config outright before.
		const parsed = parse(buildDev3CodexHooksBlock({ dialect: WINDOWS_DIALECT }));
		expect(parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe(
			'"C:\\Users\\user\\.dev3.0\\bin\\dev3.exe" hook codex',
		);
	});

	it("keeps the payload out of any command line", () => {
		// A regression fence for the bug this replaced: nothing about the hooks may
		// travel as `-c hooks={...}` again.
		const block = buildDev3CodexHooksBlock({ dialect: WINDOWS_DIALECT });
		expect(block).not.toContain("-c ");
		expect(block).not.toContain("hooks={");
	});
});

describe("patching the user's config.toml", () => {
	const patch = (content: string | null) =>
		ensureCodexConfig(content, "/Users/user/.dev3.0/worktrees", "/Users/user/.dev3.0/sockets");

	it("is idempotent — a second pass changes nothing", () => {
		const once = patch(null);
		expect(patch(once)).toBe(once);
	});

	it("replaces the previous block instead of stacking a second one", () => {
		const stale = patch(null).replace('hook codex"', 'hook codex --old"');
		const fresh = patch(stale);
		expect(fresh).not.toContain("--old");
		expect(fresh.match(/\[\[hooks\.Stop\]\]/g)).toHaveLength(1);
	});

	it("leaves the user's own hooks and comments alone", () => {
		const mine = [
			"# my notes",
			"",
			"[[hooks.Stop]]",
			"",
			"[[hooks.Stop.hooks]]",
			'type = "command"',
			'command = "/usr/local/bin/notify-me"',
			"",
		].join("\n");
		const patched = patch(mine);
		expect(patched).toContain("# my notes");
		expect(patched).toContain("/usr/local/bin/notify-me");
		// Two entries now share the event, which is what a TOML array of tables is for.
		expect(parse(patched).hooks?.Stop).toHaveLength(2);
	});

	it("produces a file that still parses with the block in it", () => {
		expect(() => parse(patch(null))).not.toThrow();
	});
});

describe("detecting the hook-trust bypass", () => {
	it("recognizes the flag in real help text", () => {
		const help = [
			"      --dangerously-bypass-approvals-and-sandbox",
			"          Skip all confirmation prompts",
			`      ${CODEX_HOOK_TRUST_BYPASS_FLAG}`,
			"          Run enabled hooks without requiring persisted hook trust",
		].join("\n");
		expect(supportsCodexHookTrustBypass(help)).toBe(true);
	});

	it("says no for a codex that only has the neighbouring dangerous flag", () => {
		// Passing a flag an older codex does not know exits 2 and the session never
		// starts, so a prefix match here would be worse than having no hooks.
		expect(supportsCodexHookTrustBypass("      --dangerously-bypass-approvals-and-sandbox")).toBe(
			false,
		);
		expect(supportsCodexHookTrustBypass("")).toBe(false);
	});

	it("does not match a longer flag that merely starts the same", () => {
		expect(supportsCodexHookTrustBypass(`${CODEX_HOOK_TRUST_BYPASS_FLAG}-v2`)).toBe(false);
	});
});
