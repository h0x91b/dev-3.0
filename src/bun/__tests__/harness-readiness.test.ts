import { describe, expect, it } from "vitest";
import { harnessReadinessFrom, harnessSignIn, type ProbeEnv } from "../harness-readiness";
import type { AgentCheckResult } from "../../shared/types";

/**
 * The gate's whole value is that it blocks ONLY on evidence. A probe that reads
 * "no credentials" from a path it never checked, or from an unreadable file, would
 * lock a perfectly configured user out of the sandbox — worse than the dead task
 * the gate exists to prevent.
 */

function probeEnv(over: Partial<ProbeEnv> & { files?: Record<string, unknown> } = {}): ProbeEnv {
	const files = over.files ?? {};
	return {
		home: "/home/u",
		env: {},
		exists: (p) => p in files,
		readJson: (p) => files[p] ?? null,
		claudeAccountDirs: () => [],
		codexAccountDirs: () => [],
		...over,
	};
}

function agent(baseCommand: string, installed = true): AgentCheckResult {
	return { agentId: `builtin-${baseCommand}`, name: baseCommand, baseCommand, installed };
}

describe("harnessSignIn", () => {
	it("says unknown for a CLI it has no probe for", () => {
		expect(harnessSignIn("some-new-agent", probeEnv())).toBe("unknown");
	});

	it("reads a Claude OAuth login out of ~/.claude.json", () => {
		const p = probeEnv({ files: { "/home/u/.claude.json": { oauthAccount: { emailAddress: "a@b.c" } } } });
		expect(harnessSignIn("claude", p)).toBe("signed-in");
	});

	it("accepts a Claude credentials file with no .claude.json at all", () => {
		expect(harnessSignIn("claude", probeEnv({ files: { "/home/u/.claude/.credentials.json": {} } }))).toBe("signed-in");
	});

	it("counts a dev3-managed Claude account dir, not just the system home", () => {
		const p = probeEnv({
			files: { "/accounts/one/.claude.json": { oauthAccount: { emailAddress: "a@b.c" } } },
			claudeAccountDirs: () => ["/accounts/one"],
		});
		expect(harnessSignIn("claude", p)).toBe("signed-in");
	});

	it("treats an API key as signed in — there is no login to do", () => {
		expect(harnessSignIn("claude", probeEnv({ env: { ANTHROPIC_API_KEY: "sk-x" } }))).toBe("signed-in");
		expect(harnessSignIn("codex", probeEnv({ env: { OPENAI_API_KEY: "sk-x" } }))).toBe("signed-in");
		expect(harnessSignIn("gemini", probeEnv({ env: { GEMINI_API_KEY: "x" } }))).toBe("signed-in");
	});

	it("ignores a blank env var — an exported empty key is not a credential", () => {
		expect(harnessSignIn("claude", probeEnv({ env: { ANTHROPIC_API_KEY: "  " } }))).toBe("not-signed-in");
	});

	it("reads Codex auth.json and rejects an emptied one", () => {
		expect(harnessSignIn("codex", probeEnv({ files: { "/home/u/.codex/auth.json": { tokens: { id_token: "x" } } } }))).toBe("signed-in");
		expect(harnessSignIn("codex", probeEnv({ files: { "/home/u/.codex/auth.json": {} } }))).toBe("not-signed-in");
	});

	it("reads Gemini's active google account", () => {
		expect(harnessSignIn("gemini", probeEnv({ files: { "/home/u/.gemini/google_accounts.json": { active: "a@b.c" } } }))).toBe("signed-in");
		expect(harnessSignIn("gemini", probeEnv({ files: { "/home/u/.gemini/google_accounts.json": { active: "" } } }))).toBe("not-signed-in");
	});

	it("reads Cursor Agent's authInfo", () => {
		expect(harnessSignIn("agent", probeEnv({ files: { "/home/u/.cursor/cli-config.json": { authInfo: { x: 1 } } } }))).toBe("signed-in");
		expect(harnessSignIn("agent", probeEnv({ files: { "/home/u/.cursor/cli-config.json": { model: "auto" } } }))).toBe("not-signed-in");
	});

	it("finds OpenCode's auth store under XDG or the plain config dir", () => {
		expect(harnessSignIn("opencode", probeEnv({ files: { "/home/u/.local/share/opencode/auth.json": { anthropic: {} } } }))).toBe("signed-in");
		expect(harnessSignIn("opencode", probeEnv({ files: { "/xdg/opencode/auth.json": { openai: {} } }, env: { XDG_DATA_HOME: "/xdg" } }))).toBe("signed-in");
		expect(harnessSignIn("opencode", probeEnv())).toBe("not-signed-in");
	});

	it("reports unknown when the probe itself throws", () => {
		const p = probeEnv({ readJson: () => { throw new Error("EACCES"); } });
		expect(harnessSignIn("codex", p)).toBe("unknown");
	});
});

describe("harnessReadinessFrom", () => {
	it("reports nothing installed when no binary resolves", () => {
		const report = harnessReadinessFrom([agent("claude", false), agent("codex", false)], probeEnv());
		expect(report.noneInstalled).toBe(true);
		expect(report.usable).toEqual([]);
	});

	it("does not probe an uninstalled CLI — its credentials are beside the point", () => {
		const p = probeEnv({ files: { "/home/u/.claude.json": { oauthAccount: {} } } });
		const report = harnessReadinessFrom([agent("claude", false)], p);
		expect(report.harnesses[0].signIn).toBe("unknown");
		expect(report.usable).toEqual([]);
	});

	it("blocks when every installed CLI is provably signed out", () => {
		const report = harnessReadinessFrom([agent("claude"), agent("codex")], probeEnv());
		expect(report.noneInstalled).toBe(false);
		expect(report.usable).toEqual([]);
	});

	it("passes an unprobeable CLI rather than blocking on our own ignorance", () => {
		const report = harnessReadinessFrom([agent("claude"), agent("some-new-agent")], probeEnv());
		expect(report.usable).toEqual(["builtin-some-new-agent"]);
	});

	it("passes as soon as one CLI holds credentials", () => {
		const p = probeEnv({ files: { "/home/u/.codex/auth.json": { tokens: {} } } });
		const report = harnessReadinessFrom([agent("claude"), agent("codex")], p);
		expect(report.usable).toEqual(["builtin-codex"]);
	});
});
