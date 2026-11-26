import { describe, expect, it } from "vitest";
import { codexHomeSignedIn, harnessReadinessFrom, harnessSignIn, type ProbeEnv } from "../harness-readiness";
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
	it("says unknown for a CLI it has no probe for, or when the probe itself throws", () => {
		expect(harnessSignIn("some-new-agent", probeEnv())).toBe("unknown");
		expect(harnessSignIn("codex", probeEnv({ readJson: () => { throw new Error("EACCES"); } }))).toBe("unknown");
	});

	it("finds a Claude login in ~/.claude.json, a bare credentials file, or a dev3-managed account dir", () => {
		const cases: Array<[name: string, p: ProbeEnv]> = [
			["OAuth login in ~/.claude.json", probeEnv({ files: { "/home/u/.claude.json": { oauthAccount: { emailAddress: "a@b.c" } } } })],
			["credentials file with no .claude.json", probeEnv({ files: { "/home/u/.claude/.credentials.json": {} } })],
			["dev3-managed account dir", probeEnv({
				files: { "/accounts/one/.claude.json": { oauthAccount: { emailAddress: "a@b.c" } } },
				claudeAccountDirs: () => ["/accounts/one"],
			})],
		];
		for (const [name, p] of cases) expect(harnessSignIn("claude", p), name).toBe("signed-in");
	});

	it("treats an API key as signed in — there is no login to do — but not a blank one", () => {
		expect(harnessSignIn("claude", probeEnv({ env: { ANTHROPIC_API_KEY: "sk-x" } }))).toBe("signed-in");
		expect(harnessSignIn("codex", probeEnv({ env: { OPENAI_API_KEY: "sk-x" } }))).toBe("signed-in");
		expect(harnessSignIn("gemini", probeEnv({ env: { GEMINI_API_KEY: "x" } }))).toBe("signed-in");
		// An exported empty key is not a credential.
		expect(harnessSignIn("claude", probeEnv({ env: { ANTHROPIC_API_KEY: "  " } }))).toBe("not-signed-in");
	});

	it("reads Codex auth.json, Gemini's active account and Cursor Agent's authInfo, rejecting an emptied one", () => {
		const cases: Array<[cli: string, file: string, good: unknown, emptied: unknown]> = [
			["codex", "/home/u/.codex/auth.json", { tokens: { id_token: "x" } }, {}],
			["gemini", "/home/u/.gemini/google_accounts.json", { active: "a@b.c" }, { active: "" }],
			["agent", "/home/u/.cursor/cli-config.json", { authInfo: { x: 1 } }, { model: "auto" }],
		];
		for (const [cli, file, good, emptied] of cases) {
			expect(harnessSignIn(cli, probeEnv({ files: { [file]: good } })), cli).toBe("signed-in");
			expect(harnessSignIn(cli, probeEnv({ files: { [file]: emptied } })), cli).toBe("not-signed-in");
		}
	});

	it("finds OpenCode's auth store under XDG or the plain config dir", () => {
		expect(harnessSignIn("opencode", probeEnv({ files: { "/home/u/.local/share/opencode/auth.json": { anthropic: {} } } }))).toBe("signed-in");
		expect(harnessSignIn("opencode", probeEnv({ files: { "/xdg/opencode/auth.json": { openai: {} } }, env: { XDG_DATA_HOME: "/xdg" } }))).toBe("signed-in");
		expect(harnessSignIn("opencode", probeEnv())).toBe("not-signed-in");
	});

	it("says unknown for omp — its credentials are in SQLite, not a JSON file", () => {
		// Guessing a path here would report a working, signed-in omp as logged out
		// and block the sandbox on our own ignorance.
		expect(harnessSignIn("omp", probeEnv())).toBe("unknown");
		expect(harnessSignIn("omp", probeEnv({ env: { ANTHROPIC_API_KEY: "sk-x" } }))).toBe("unknown");
	});

	it("says unknown for plain pi — no auth.json is not evidence of no provider", () => {
		// pi runs on provider env vars and models.json as readily as on /login.
		expect(harnessSignIn("pi", probeEnv())).toBe("unknown");
		expect(harnessSignIn("pi", probeEnv({ files: { "/home/u/.pi/agent/auth.json": { anthropic: {} } } }))).toBe("unknown");
	});
});

describe("harnessReadinessFrom", () => {
	it("reports nothing installed when no binary resolves, without probing an uninstalled CLI's credentials", () => {
		const report = harnessReadinessFrom([agent("claude", false), agent("codex", false)], probeEnv());
		expect(report.noneInstalled).toBe(true);
		expect(report.usable).toEqual([]);
		const p = probeEnv({ files: { "/home/u/.claude.json": { oauthAccount: {} } } });
		const uninstalled = harnessReadinessFrom([agent("claude", false)], p);
		expect(uninstalled.harnesses[0].signIn).toBe("unknown");
		expect(uninstalled.usable).toEqual([]);
	});

	it("blocks only when every installed CLI is provably signed out, passing an unprobeable or credentialed one", () => {
		const signedOut = harnessReadinessFrom([agent("claude"), agent("codex")], probeEnv());
		expect(signedOut.noneInstalled).toBe(false);
		expect(signedOut.usable).toEqual([]);
		// An unprobeable CLI passes rather than blocking on our own ignorance.
		expect(harnessReadinessFrom([agent("claude"), agent("some-new-agent")], probeEnv()).usable).toEqual(["builtin-some-new-agent"]);
		const p = probeEnv({ files: { "/home/u/.codex/auth.json": { tokens: {} } } });
		expect(harnessReadinessFrom([agent("claude"), agent("codex")], p).usable).toEqual(["builtin-codex"]);
	});
});

describe("codexHomeSignedIn", () => {
	it("needs a non-empty auth.json in that exact home", () => {
		const files: Record<string, unknown> = { "/acct/auth.json": { tokens: { id_token: "x" } }, "/empty/auth.json": {} };
		const readJson = (path: string) => files[path] ?? null;
		expect(codexHomeSignedIn("/acct", readJson)).toBe(true);
		expect(codexHomeSignedIn("/empty", readJson)).toBe(false);
		expect(codexHomeSignedIn("/missing", readJson)).toBe(false);
	});
});
