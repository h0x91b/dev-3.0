import { describe, expect, it } from "vitest";
import {
	getAgentAdapter,
	hasAgentAdapter,
	agentKey,
	claudeAdapter,
	codexAdapter,
	geminiAdapter,
	cursorAdapter,
	opencodeAdapter,
	genericAdapter,
	shellEscape,
	type AdapterLaunchOptions,
	type TemplateContext,
} from "../../shared/agent-adapters";
import { CLAUDE_SKILL_BODY, CODEX_SKILL_BODY, GENERIC_SKILL_BODY } from "../../shared/agent-skill-content";
import type { AgentConfiguration } from "../../shared/types";

// ---------------------------------------------------------------------------
// Seam B — per-adapter contract tests. Each adapter is a PURE descriptor, so
// these assert its launchArgs / buildResumeCommand / trustKinds / hooksSpec /
// capability flags in isolation, with no fs/PTY. Skill bodies are redacted to
// sentinels (the full-matrix byte-identity vs. the backend is guarded by the
// Seam A golden test once resolveAgentCommand delegates here).
// ---------------------------------------------------------------------------

function redact(cmd: string): string {
	const genericEscapedInner = shellEscape(GENERIC_SKILL_BODY).slice(1, -1);
	return cmd
		.split(shellEscape(CLAUDE_SKILL_BODY)).join("<CLAUDE_BODY>")
		.split(shellEscape(`developer_instructions=${JSON.stringify(CODEX_SKILL_BODY)}`)).join("<CODEX_DEV_INSTR>")
		.split(genericEscapedInner).join("<GENERIC_BODY>");
}

const CTX: TemplateContext = {
	taskTitle: "Fix bug",
	taskDescription: "Fix the login bug",
	projectName: "my-project",
	projectPath: "/path/to/project",
	worktreePath: "/path/to/worktree",
};
const cfg = (o?: Partial<AgentConfiguration>): AgentConfiguration => ({ id: "d", name: "D", ...o });
const CODEX_RT = { themedProfile: "dev3-dark", theme: "dracula", profileLaunchFlag: "--profile" } as const;

/** Run an adapter's launchArgs, join to a string, and redact skill bodies. */
function launch(base: string, config: AgentConfiguration | undefined, options?: AdapterLaunchOptions): string {
	return redact(getAgentAdapter(base).launchArgs(base, config, CTX, options).join(" "));
}

describe("registry", () => {
	it("resolves known base commands by last path segment", () => {
		expect(getAgentAdapter("claude")).toBe(claudeAdapter);
		expect(getAgentAdapter("/opt/homebrew/bin/codex")).toBe(codexAdapter);
		expect(getAgentAdapter("/usr/local/bin/gemini")).toBe(geminiAdapter);
		expect(getAgentAdapter("agent")).toBe(cursorAdapter);
		expect(getAgentAdapter("opencode")).toBe(opencodeAdapter);
	});

	it("falls back to the generic adapter for unknown / custom commands", () => {
		expect(getAgentAdapter("aider")).toBe(genericAdapter);
		expect(getAgentAdapter("bash")).toBe(genericAdapter);
		expect(getAgentAdapter("/weird/path/my-agent")).toBe(genericAdapter);
	});

	it("hasAgentAdapter / agentKey", () => {
		expect(hasAgentAdapter("claude")).toBe(true);
		expect(hasAgentAdapter("aider")).toBe(false);
		expect(agentKey("/a/b/claude")).toBe("claude");
		expect(agentKey("codex")).toBe("codex");
	});
});

describe("capability flags", () => {
	it.each([
		[claudeAdapter, "claude", true, true],
		[codexAdapter, "codex", true, false],
		[geminiAdapter, "gemini", true, true],
		[cursorAdapter, "agent", true, true],
		[opencodeAdapter, "opencode", true, false],
		[genericAdapter, "", false, false],
	] as const)("%s", (adapter, command, resume, preassign) => {
		expect(adapter.command).toBe(command);
		expect(adapter.supportsResume).toBe(resume);
		expect(adapter.supportsPreAssignedSessionId).toBe(preassign);
	});
});

describe("trustKinds", () => {
	it.each([
		[claudeAdapter, ["claude"]],
		[codexAdapter, ["claude", "codex"]],
		[geminiAdapter, ["claude", "gemini"]],
		[cursorAdapter, ["claude"]],
		[opencodeAdapter, ["claude"]],
		[genericAdapter, ["claude"]],
	] as const)("%s", (adapter, kinds) => {
		expect(adapter.trustKinds).toEqual(kinds);
	});
});

describe("hooksSpec", () => {
	it("Claude threads stopTarget + permissionMode", () => {
		expect(claudeAdapter.hooksSpec({ stopTarget: "review-by-ai", permissionMode: "bypassPermissions" }))
			.toEqual({ kind: "claude", stopTarget: "review-by-ai", permissionMode: "bypassPermissions" });
		expect(claudeAdapter.hooksSpec()).toEqual({ kind: "claude", stopTarget: undefined, permissionMode: undefined });
	});
	it("Codex is a bare codex spec", () => {
		expect(codexAdapter.hooksSpec()).toEqual({ kind: "codex" });
	});
	it("Gemini / Cursor / OpenCode / Generic install no hooks", () => {
		expect(geminiAdapter.hooksSpec()).toBeNull();
		expect(cursorAdapter.hooksSpec()).toBeNull();
		expect(opencodeAdapter.hooksSpec()).toBeNull();
		expect(genericAdapter.hooksSpec()).toBeNull();
	});
});

describe("buildResumeCommand", () => {
	it.each([
		[claudeAdapter, "claude", undefined, "claude --continue"],
		[claudeAdapter, "claude", "sid", "claude --resume sid"],
		[codexAdapter, "codex", undefined, "codex resume --last"],
		[codexAdapter, "codex", "sid", "codex resume sid"],
		[geminiAdapter, "gemini", undefined, "gemini --resume latest"],
		[geminiAdapter, "gemini", "sid", "gemini --resume sid"],
		[cursorAdapter, "agent", undefined, "agent --continue"],
		[cursorAdapter, "agent", "sid", "agent --resume sid"],
		[opencodeAdapter, "opencode", undefined, "opencode --continue"],
		[opencodeAdapter, "opencode", "sid", "opencode --session sid"],
		[genericAdapter, "aider", "sid", null],
	] as const)("%s (sid=%s)", (adapter, base, sid, expected) => {
		expect(adapter.buildResumeCommand(base, sid ?? undefined)).toBe(expected);
	});
});

describe("skillBody", () => {
	it("each adapter carries the right body", () => {
		expect(claudeAdapter.skillBody).toBe(CLAUDE_SKILL_BODY);
		expect(codexAdapter.skillBody).toBe(CODEX_SKILL_BODY);
		// Gemini/Cursor/OpenCode/Generic use the generic body.
		expect(geminiAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(cursorAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(opencodeAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(genericAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
	});
});

describe("launchArgs — Claude", () => {
	it("fresh: model + system prompt + positional prompt", () => {
		expect(launch("claude", cfg({ model: "sonnet" })))
			.toBe("claude --model sonnet --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'");
	});
	it("resume with sessionId drops the prompt", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { resume: true, sessionId: "sid" }))
			.toBe("claude --resume sid --model sonnet --append-system-prompt <CLAUDE_BODY>");
	});
	it("skipModelForProvider omits --model", () => {
		expect(launch("claude", cfg({ model: "claude-opus-4-8[1m]" }), { skipModelForProvider: true }))
			.toBe("claude --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'");
	});
	it("skipSystemPrompt omits the body", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { skipSystemPrompt: true }))
			.toBe("claude --model sonnet -- 'Fix the login bug'");
	});
	it("statusline settings after the body, unless user passes --settings", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { statuslineSettingsFile: "/tmp/s.json" }))
			.toBe("claude --model sonnet --append-system-prompt <CLAUDE_BODY> --settings /tmp/s.json -- 'Fix the login bug'");
		expect(launch("claude", cfg({ model: "sonnet", additionalArgs: ["--settings", "x"] }), { statuslineSettingsFile: "/tmp/s.json" }))
			.toBe("claude --model sonnet --append-system-prompt <CLAUDE_BODY> --settings x -- 'Fix the login bug'");
	});
});

describe("launchArgs — Codex", () => {
	it("theme + developer_instructions + resume subcommand", () => {
		expect(launch("codex", cfg({ model: "gpt-5.6-sol" }), { codex: CODEX_RT }))
			.toBe("codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'");
		expect(launch("codex", cfg({ model: "gpt-5.6-sol" }), { resume: true, sessionId: "sid", codex: CODEX_RT }))
			.toBe("codex resume sid --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR>");
	});
	it("rewrites a dev3 profile to the themed profile", () => {
		expect(launch("codex", cfg({ model: "gpt-5.6-sol", additionalArgs: ["-p", "dev3"] }), { codex: CODEX_RT }))
			.toBe("codex --model gpt-5.6-sol -p dev3-dark -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'");
	});
	it("profile-v2 codex rewrites -p to --profile-v2", () => {
		expect(launch("codex", cfg({ model: "gpt-5.6-sol", additionalArgs: ["-p", "dev3"] }), { codex: { ...CODEX_RT, profileLaunchFlag: "--profile-v2" } }))
			.toContain("--profile-v2 dev3-dark");
	});
});

describe("launchArgs — Gemini / Cursor / OpenCode / Generic", () => {
	it("Gemini maps permission mode to --approval-mode", () => {
		expect(launch("gemini", cfg({ model: "gemini-3-pro", permissionMode: "bypassPermissions" })))
			.toBe("gemini --model gemini-3-pro --approval-mode yolo -- 'Fix the login bug'");
	});
	it("Cursor injects the generic body via the prompt and maps modes", () => {
		expect(launch("agent", cfg({ permissionMode: "plan" })))
			.toBe("agent --mode plan -- 'Fix the login bug\n\n<GENERIC_BODY>'");
		expect(launch("agent", cfg({ permissionMode: "bypassPermissions" })))
			.toBe("agent --force -- 'Fix the login bug\n\n<GENERIC_BODY>'");
	});
	it("OpenCode uses --prompt and ignores generic flags", () => {
		expect(launch("opencode", cfg({ model: "anthropic/claude-opus-4-6", permissionMode: "bypassPermissions", effort: "high" })))
			.toBe("opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'");
	});
	it("Generic emits Claude-shaped flags but no body", () => {
		expect(launch("aider", cfg({ model: "sonnet", permissionMode: "plan", effort: "high", maxBudgetUsd: 12 })))
			.toBe("aider --model sonnet --permission-mode plan --effort high --max-budget-usd 12 -- 'Fix the login bug'");
	});
	it("Generic does not resume or pre-assign a session id", () => {
		expect(launch("aider", cfg({ model: "sonnet" }), { resume: true, sessionId: "sid" }))
			.toBe("aider --model sonnet -- 'Fix the login bug'");
	});
});
