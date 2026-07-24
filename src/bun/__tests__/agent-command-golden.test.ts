import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveAgentCommand,
	buildResumeCommand,
	DEV3_SYSTEM_PROMPT,
	DEV3_SYSTEM_PROMPT_CODEX,
	DEV3_SYSTEM_PROMPT_GENERIC,
	shellEscape,
	__setCodexProfileV2Override,
	type CommandOptions,
	type TemplateContext,
} from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";
import { setCurrentUiTheme } from "../theme-state";

// ---------------------------------------------------------------------------
// Golden / characterization test (Seam A) — decision 124 / AgentAdapter spec.
//
// Pins the *structure* of every launch command `resolveAgentCommand` produces
// across an (agent × config × options) matrix so the AgentAdapter refactor can
// be proved byte-identical. The three multi-KB skill bodies are redacted to
// stable sentinels (<CLAUDE_BODY>, <CODEX_DEV_INSTR>, <GENERIC_BODY>) so this
// test guards flags / quoting / delivery-channel / ordering — NOT the protocol
// prose (which changes often and is not load-bearing for command assembly).
// The wrapper around each body (e.g. `--append-system-prompt '<CLAUDE_BODY>'`
// vs `-c <CODEX_DEV_INSTR>`) stays visible, so a lost quote or a wrong delivery
// channel still fails the test.
// ---------------------------------------------------------------------------

/** Redact the three skill bodies to sentinels, matching how each is embedded. */
function redact(cmd: string): string {
	const claudeBody = shellEscape(DEV3_SYSTEM_PROMPT);
	const codexBody = shellEscape(`developer_instructions=${JSON.stringify(DEV3_SYSTEM_PROMPT_CODEX)}`);
	// The generic body is concatenated onto the prompt then shell-escaped as a
	// whole, so its apostrophes are rewritten ('→'\''). Redact the escaped inner.
	const genericEscapedInner = shellEscape(DEV3_SYSTEM_PROMPT_GENERIC).slice(1, -1);
	return cmd
		.split(claudeBody).join("<CLAUDE_BODY>")
		.split(codexBody).join("<CODEX_DEV_INSTR>")
		.split(genericEscapedInner).join("<GENERIC_BODY>");
}

const CTX: TemplateContext = {
	taskTitle: "Fix bug",
	taskDescription: "Fix the login bug",
	projectName: "my-project",
	projectPath: "/path/to/project",
	worktreePath: "/path/to/worktree",
};
const EMPTY_CTX: TemplateContext = { ...CTX, taskDescription: "" };

const agent = (baseCommand: string): CodingAgent => ({
	id: "a",
	name: "A",
	baseCommand,
	configurations: [],
	defaultConfigId: "d",
});
const cfg = (o?: Partial<AgentConfiguration>): AgentConfiguration => ({ id: "d", name: "D", model: "sonnet", ...o });

const SID = "11111111-1111-1111-1111-111111111111";
const BASES = ["claude", "codex", "gemini", "agent", "opencode", "aider"];

/** Per-agent model, matching the generator that produced EXPECTED below. */
function modelFor(base: string): string | undefined {
	if (base === "codex") return "gpt-5.6-sol";
	if (base === "opencode") return "anthropic/claude-opus-4-6";
	if (base === "gemini") return "gemini-3-pro";
	if (base === "agent") return undefined;
	return "sonnet";
}

interface Case {
	name: string;
	base: string;
	config: AgentConfiguration;
	options?: CommandOptions;
	ctx?: TemplateContext;
}

function buildCases(): Case[] {
	const cases: Case[] = [];
	const push = (name: string, base: string, config: AgentConfiguration, options?: CommandOptions, ctx?: TemplateContext) =>
		cases.push({ name, base, config, options, ctx });

	for (const b of BASES) {
		const model = modelFor(b);
		push(`${b}/fresh`, b, cfg({ model }));
		push(`${b}/fresh-empty`, b, cfg({ model }), undefined, EMPTY_CTX);
		push(`${b}/resume-nosid`, b, cfg({ model }), { resume: true });
		push(`${b}/resume-sid`, b, cfg({ model }), { resume: true, sessionId: SID });
		push(`${b}/preassign-sid`, b, cfg({ model }), { sessionId: SID });
		push(`${b}/skipSysPrompt`, b, cfg({ model }), { skipSystemPrompt: true });
		push(`${b}/statusline`, b, cfg({ model }), { statuslineSettingsFile: "/tmp/s.json" });
		for (const pm of ["plan", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
			push(`${b}/pm-${pm}`, b, cfg({ model, permissionMode: pm }));
		}
		push(`${b}/effort`, b, cfg({ model, effort: "high" }));
		push(`${b}/budget`, b, cfg({ model, maxBudgetUsd: 12 }));
		push(`${b}/addargs`, b, cfg({ model, additionalArgs: ["--foo", "bar"] }));
		push(`${b}/appendPrompt`, b, cfg({ model, appendPrompt: "Extra: {{TASK_TITLE}}" }));
	}
	push("claude/provider-bedrock", "claude", cfg({ model: "claude-opus-4-8[1m]" }), { llmProvider: "bedrock" });
	// Codex on Bedrock: --model keeps the (rewritten) id; routing rides -c args.
	push("codex/provider-bedrock", "codex", cfg({ model: "openai.gpt-5.6-sol" }), { llmProvider: "bedrock-codex" });
	push("claude/model-1m", "claude", cfg({ model: "claude-opus-4-8[1m]" }));
	push("codex/theme-profile", "codex", cfg({ model: "gpt-5.6-sol", additionalArgs: ["-p", "dev3"] }));
	return cases;
}

// Captured against the pre-refactor code (reproduce-first). The AgentAdapter
// migration must reproduce every one of these strings verbatim.
const EXPECTED: Record<string, string> = {
	"claude/fresh": "claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/fresh-empty": "claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY>",
	"claude/resume-nosid": "claude --continue --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY>",
	"claude/resume-sid": "claude --resume 11111111-1111-1111-1111-111111111111 --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY>",
	"claude/preassign-sid": "claude --session-id 11111111-1111-1111-1111-111111111111 --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/skipSysPrompt": "claude --model sonnet --allow-dangerously-skip-permissions -- 'Fix the login bug'",
	"claude/statusline": "claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> --settings /tmp/s.json -- 'Fix the login bug'",
	"claude/pm-plan": "claude --model sonnet --permission-mode plan --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/pm-acceptEdits": "claude --model sonnet --permission-mode acceptEdits --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/pm-bypassPermissions": "claude --model sonnet --permission-mode bypassPermissions --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/pm-dontAsk": "claude --model sonnet --permission-mode dontAsk --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/effort": "claude --model sonnet --allow-dangerously-skip-permissions --effort high --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/budget": "claude --model sonnet --allow-dangerously-skip-permissions --max-budget-usd 12 --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"claude/addargs": "claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> --foo bar -- 'Fix the login bug'",
	"claude/appendPrompt": "claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug\n\nExtra: Fix bug'",
	"codex/fresh": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/fresh-empty": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR>",
	"codex/resume-nosid": "codex resume --last --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR>",
	"codex/resume-sid": "codex resume 11111111-1111-1111-1111-111111111111 --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR>",
	"codex/preassign-sid": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/skipSysPrompt": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -- 'Fix the login bug'",
	"codex/statusline": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/pm-plan": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/pm-acceptEdits": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/pm-bypassPermissions": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/pm-dontAsk": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/effort": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/budget": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/addargs": "codex --model gpt-5.6-sol --foo bar -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"codex/appendPrompt": "codex --model gpt-5.6-sol -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug\n\nExtra: Fix bug'",
	"gemini/fresh": "gemini --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/fresh-empty": "gemini --model gemini-3-pro",
	"gemini/resume-nosid": "gemini --resume latest --model gemini-3-pro",
	"gemini/resume-sid": "gemini --resume 11111111-1111-1111-1111-111111111111 --model gemini-3-pro",
	"gemini/preassign-sid": "gemini --session-id 11111111-1111-1111-1111-111111111111 --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/skipSysPrompt": "gemini --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/statusline": "gemini --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/pm-plan": "gemini --model gemini-3-pro --approval-mode plan -- 'Fix the login bug'",
	"gemini/pm-acceptEdits": "gemini --model gemini-3-pro --approval-mode auto_edit -- 'Fix the login bug'",
	"gemini/pm-bypassPermissions": "gemini --model gemini-3-pro --approval-mode yolo -- 'Fix the login bug'",
	"gemini/pm-dontAsk": "gemini --model gemini-3-pro --approval-mode yolo -- 'Fix the login bug'",
	"gemini/effort": "gemini --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/budget": "gemini --model gemini-3-pro -- 'Fix the login bug'",
	"gemini/addargs": "gemini --model gemini-3-pro --foo bar -- 'Fix the login bug'",
	"gemini/appendPrompt": "gemini --model gemini-3-pro -- 'Fix the login bug\n\nExtra: Fix bug'",
	"agent/fresh": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/fresh-empty": "agent",
	"agent/resume-nosid": "agent --continue",
	"agent/resume-sid": "agent --resume 11111111-1111-1111-1111-111111111111",
	"agent/preassign-sid": "agent --resume 11111111-1111-1111-1111-111111111111 -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/skipSysPrompt": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/statusline": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/pm-plan": "agent --mode plan -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/pm-acceptEdits": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/pm-bypassPermissions": "agent --force -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/pm-dontAsk": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/effort": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/budget": "agent -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/addargs": "agent --foo bar -- 'Fix the login bug\n\n<GENERIC_BODY>'",
	"agent/appendPrompt": "agent -- 'Fix the login bug\n\nExtra: Fix bug\n\n<GENERIC_BODY>'",
	"opencode/fresh": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/fresh-empty": "opencode --model anthropic/claude-opus-4-6",
	"opencode/resume-nosid": "opencode --continue --model anthropic/claude-opus-4-6",
	"opencode/resume-sid": "opencode --session 11111111-1111-1111-1111-111111111111 --model anthropic/claude-opus-4-6",
	"opencode/preassign-sid": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/skipSysPrompt": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/statusline": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/pm-plan": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/pm-acceptEdits": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/pm-bypassPermissions": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/pm-dontAsk": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/effort": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/budget": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/addargs": "opencode --model anthropic/claude-opus-4-6 --foo bar --prompt 'Fix the login bug\n\n<GENERIC_BODY>'",
	"opencode/appendPrompt": "opencode --model anthropic/claude-opus-4-6 --prompt 'Fix the login bug\n\nExtra: Fix bug\n\n<GENERIC_BODY>'",
	"aider/fresh": "aider --model sonnet -- 'Fix the login bug'",
	"aider/fresh-empty": "aider --model sonnet",
	"aider/resume-nosid": "aider --model sonnet -- 'Fix the login bug'",
	"aider/resume-sid": "aider --model sonnet -- 'Fix the login bug'",
	"aider/preassign-sid": "aider --model sonnet -- 'Fix the login bug'",
	"aider/skipSysPrompt": "aider --model sonnet -- 'Fix the login bug'",
	"aider/statusline": "aider --model sonnet -- 'Fix the login bug'",
	"aider/pm-plan": "aider --model sonnet --permission-mode plan -- 'Fix the login bug'",
	"aider/pm-acceptEdits": "aider --model sonnet --permission-mode acceptEdits -- 'Fix the login bug'",
	"aider/pm-bypassPermissions": "aider --model sonnet --permission-mode bypassPermissions -- 'Fix the login bug'",
	"aider/pm-dontAsk": "aider --model sonnet --permission-mode dontAsk -- 'Fix the login bug'",
	"aider/effort": "aider --model sonnet --effort high -- 'Fix the login bug'",
	"aider/budget": "aider --model sonnet --max-budget-usd 12 -- 'Fix the login bug'",
	"aider/addargs": "aider --model sonnet --foo bar -- 'Fix the login bug'",
	"aider/appendPrompt": "aider --model sonnet -- 'Fix the login bug\n\nExtra: Fix bug'",
	"claude/provider-bedrock": "claude --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"codex/provider-bedrock": "codex --model openai.gpt-5.6-sol -c 'model_provider=\"amazon-bedrock\"' -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
	"claude/model-1m": "claude --model 'claude-opus-4-8[1m]' --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'",
	"codex/theme-profile": "codex --model gpt-5.6-sol -p dev3-dark -c 'tui.theme=\"dracula\"' -c <CODEX_DEV_INSTR> -- 'Fix the login bug'",
};

beforeEach(() => {
	setCurrentUiTheme("dark");
	// Force pre-0.131 profile semantics so codex theme cases are deterministic
	// regardless of the installed codex version.
	__setCodexProfileV2Override(false);
});

afterEach(() => {
	__setCodexProfileV2Override(null);
});

describe("resolveAgentCommand — golden matrix (structural, byte-identical)", () => {
	const cases = buildCases();

	it("covers every EXPECTED case (no drift between matrix and expectations)", () => {
		const caseNames = new Set(cases.map((c) => c.name));
		const expectedNames = new Set(Object.keys(EXPECTED));
		expect([...caseNames].sort()).toEqual([...expectedNames].sort());
	});

	it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const out = resolveAgentCommand(agent(c.base), c.config, c.ctx ?? CTX, c.options);
		expect(redact(out)).toBe(EXPECTED[c.name]);
	});
});

describe("buildResumeCommand — golden", () => {
	it.each([
		["claude", undefined, "claude --continue"],
		["claude", "sid-x", "claude --resume sid-x"],
		["codex", undefined, "codex resume --last"],
		["codex", "sid-x", "codex resume sid-x"],
		["gemini", undefined, "gemini --resume latest"],
		["gemini", "sid-x", "gemini --resume sid-x"],
		["agent", undefined, "agent --continue"],
		["agent", "sid-x", "agent --resume sid-x"],
		["opencode", undefined, "opencode --continue"],
		["opencode", "sid-x", "opencode --session sid-x"],
		["aider", undefined, null],
		["aider", "sid-x", null],
		["bash", undefined, null],
	] as const)("%s (sid=%s)", (base, sid, expected) => {
		expect(buildResumeCommand(base, sid ?? undefined)).toBe(expected);
	});
});
