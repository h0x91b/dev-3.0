import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentCommand, resolveAgentCommandDetails, supportsResume, supportsPreAssignedSessionId, buildResumeCommand, skillInvocationPrefix, ensureClaudeMcpApproved, mergeMcpApproval, mergeWithDefaults, applyBinaryPathOverride, applyLayoutResync, findConfig, migrateOldFormat, applyModelOverride, applyProviderModel, resolveLaunchConfig, claudeModelFamily, claudeDefaultEnv, getDefaultEnvForAgent, __setCodexProfileV2Override, type TemplateContext } from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";
import { DEFAULT_AGENTS } from "../../shared/types";
import { ENV_UNSET } from "../../shared/agent-accounts";
import { CLAUDE_SKILL_BODY } from "../../shared/agent-skill-content";
import { AGENT_PROMPTS_DIR } from "../agent-system-prompt-file";
import { setCurrentUiTheme } from "../theme-state";

const makeAgent = (overrides?: Partial<CodingAgent>): CodingAgent => ({
	id: "test-agent",
	name: "Test",
	baseCommand: "claude",
	configurations: [],
	defaultConfigId: "default",
	...overrides,
});

const makeConfig = (overrides?: Partial<AgentConfiguration>): AgentConfiguration => ({
	id: "default",
	name: "Default",
	model: "sonnet",
	...overrides,
});

const makeCtx = (overrides?: Partial<TemplateContext>): TemplateContext => ({
	taskTitle: "Fix bug",
	taskDescription: "Fix the login bug",
	projectName: "my-project",
	projectPath: "/path/to/project",
	worktreePath: "/path/to/worktree",
	...overrides,
});

beforeEach(() => {
	setCurrentUiTheme("dark");
	// Default to legacy (pre-0.131) profile semantics so codex theme tests are
	// deterministic regardless of the Codex version installed on the machine.
	__setCodexProfileV2Override(false);
});

afterEach(() => {
	__setCodexProfileV2Override(null);
});

describe("skillInvocationPrefix", () => {
	it.each([
		["/opt/homebrew/bin/codex", "$"],
		["claude", "/"],
		["/home/me/.bun/bin/omp", "/skill:"],
		["pi", "/skill:"],
	])("%s → %s", (command, expected) => {
		expect(skillInvocationPrefix(command)).toBe(expected);
	});
});

describe("supportsResume", () => {
	it.each([
		["claude", true],
		["codex", true],
		["gemini", true],
		["agent", true],
		["opencode", true],
		["bash", false],
	])("%s → %s", (cmd, expected) => {
		expect(supportsResume(cmd)).toBe(expected);
	});
});

describe("resolveAgentCommand — resume", () => {
	it("Claude: the protocol body travels as a file on POSIX too, not in argv (#1734)", async () => {
		const cmd = await resolveAgentCommand(makeAgent({ baseCommand: "claude" }), makeConfig(), makeCtx());

		expect(cmd).toContain("--append-system-prompt-file");
		expect(cmd).not.toContain("--append-system-prompt '");
		// The prose used to sit in argv, where `pkill -f` matched every agent on it.
		expect(cmd).not.toContain(CLAUDE_SKILL_BODY.slice(0, 40));
		expect(readFileSync(join(AGENT_PROMPTS_DIR, "claude.md"), "utf-8")).toBe(CLAUDE_SKILL_BODY);
	});

	it("Codex: refuses to resume without a conversation id instead of using --last (#1847)", async () => {
		await expect(resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		)).rejects.toThrow(/never resumes Codex with --last/);
	});

	it("Codex: ignores unsupported generic config flags, fresh and on resume", async () => {
		const config = makeConfig({
			model: "gpt-5",
			permissionMode: "bypassPermissions",
			effort: "high",
			maxBudgetUsd: 10,
		});
		const fresh = await resolveAgentCommand(makeAgent({ baseCommand: "codex" }), config, makeCtx({ taskDescription: "Some task" }));
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			config,
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true, sessionId: "sid-1" },
		);

		expect(cmd).toMatch(/^codex resume sid-1/);
		for (const [label, c] of [["fresh", fresh], ["resume", cmd]] as const) {
			expect(c, label).toContain("--model gpt-5");
			expect(c, label).not.toContain("--permission-mode");
			expect(c, label).not.toContain("--effort");
			expect(c, label).not.toContain("--max-budget-usd");
		}
	});

	it("Codex: injects the dev3 protocol via -c developer_instructions, not the prompt", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		// Protocol is delivered as a developer-role message via config override.
		// The value is a JSON-stringified TOML basic string, so inner double
		// quotes appear escaped (shell="/bin/bash" → shell=\"/bin/bash\").
		expect(cmd).toContain("-c 'developer_instructions=");
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain("Never call `dev3 task move` for normal lifecycle transitions");
		expect(cmd).not.toContain("task move --status in-progress");
		expect(cmd).toContain('shell=\\"/bin/bash\\"');
		expect(cmd).toContain("user-questions");
		// The user prompt stays clean — no skill body appended to it.
		expect(cmd).toContain("-- 'Some task'");
	});

	it("Codex: uses github theme when dev3 UI theme is light", async () => {
		setCurrentUiTheme("light");

		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p dev3-light");
		expect(cmd).not.toContain("-p dev3 ");
		expect(cmd).toContain(`-c 'tui.theme="github"'`);
	});

	it("Codex: keeps user -c overrides and appends the dev3 theme after them", async () => {
		const codexWith = (additionalArgs: string[]) => resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs }),
			makeCtx({ taskDescription: "Some task" }),
		);

		// The dev3 permissions preset now lands between them: this preset names a
		// profile but decides nothing about permissions.
		const unrelated = await codexWith(["-p", "dev3", "-c", 'model_reasoning_effort="high"']);
		expect(unrelated, "unrelated override").toContain(`-c model_reasoning_effort="high"`);
		expect(unrelated, "unrelated override").toContain(`-c 'tui.theme="dracula"'`);

		const conflicting = await codexWith(["-p", "dev3", "-c", 'tui.theme="nord"']);
		expect(conflicting.indexOf('tui.theme="nord"'), "conflicting override comes first")
			.toBeLessThan(conflicting.indexOf('tui.theme="dracula"'));
	});

	it("Codex: leaves custom profile names untouched (legacy and profile-v2)", async () => {
		const customProfile = () => resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "my-custom-profile"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		setCurrentUiTheme("light");
		const legacy = await customProfile();
		expect(legacy, "legacy").toContain("-p my-custom-profile");
		expect(legacy, "legacy").not.toContain("-p dev3-light");

		setCurrentUiTheme("dark");
		__setCodexProfileV2Override(true);
		const v2 = await customProfile();
		expect(v2, "profile-v2").toContain("-p my-custom-profile");
		expect(v2, "profile-v2").not.toContain("--profile-v2");
	});

	it("Codex: rewrites -p / --profile to --profile-v2 on profile-v2 Codex", async () => {
		__setCodexProfileV2Override(true);
		const codexWith = (additionalArgs: string[]) => resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs }),
			makeCtx({ taskDescription: "Some task" }),
		);

		setCurrentUiTheme("dark");
		const short = await codexWith(["-p", "dev3"]);
		expect(short, "-p (dark)").toContain("--profile-v2 dev3-dark");
		expect(short, "-p (dark)").not.toContain("-p dev3-dark");
		expect(short, "-p (dark)").not.toContain("-p dev3 ");

		setCurrentUiTheme("light");
		const long = await codexWith(["--profile", "dev3"]);
		expect(long, "--profile (light)").toContain("--profile-v2 dev3-light");
		expect(long, "--profile (light)").not.toContain("--profile dev3-light");
	});

	it("Codex: never emits --profile-v2 on newer codex that removed it (issue #611)", async () => {
		setCurrentUiTheme("dark");
		// false => launch flag is the post-rename `--profile`, so the user's `-p`
		// must be kept as-is and `--profile-v2` must never appear (it aborts codex).
		__setCodexProfileV2Override(false);

		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p dev3-dark");
		expect(cmd).not.toContain("--profile-v2");
	});

	it("OpenCode: does not emit --permission-mode, --effort, or --max-budget-usd", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({
				model: "anthropic/claude-opus-4-6",
				permissionMode: "bypassPermissions",
				effort: "high",
				maxBudgetUsd: 10,
			}),
			makeCtx(),
		);

		expect(cmd).not.toContain("--permission-mode");
		expect(cmd).not.toContain("--effort");
		expect(cmd).not.toContain("--max-budget-usd");
	});
});

describe("resolveAgentCommand — empty description (scratch task) opens interactive window", () => {
	// Regression: scratch tasks force an empty description (task-lifecycle.ts).
	// Codex/Cursor/OpenCode have no --append-system-prompt, so the system prompt
	// used to be injected as the positional prompt — which the agent then
	// auto-ran as turn 1. With an empty prompt it must NOT be injected, so the
	// agent opens an empty interactive window (matching Claude).

	it("Codex: empty description → no positional prompt; protocol still arrives via -c", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		// No positional prompt — codex opens an empty interactive window … (the
		// protocol text itself may quote ` -- `, so it is cut out first)
		expect(cmd.replace(/-c 'developer_instructions=.*"'/s, "")).not.toMatch(/ -- /);
		// … but the protocol is still delivered out-of-band (developer message),
		// which is exactly what scratch tasks were missing with prompt-append.
		expect(cmd).toContain("-c 'developer_instructions=");
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain(`-c 'tui.theme="dracula"'`);
	});

	it("Cursor Agent: empty description → no positional prompt, no system prompt injected", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		expect(cmd).not.toContain("Task Lifecycle Protocol");
		expect(cmd).not.toMatch(/ -- /);
	});

	it("OpenCode: empty description → no --prompt, no system prompt injected", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		expect(cmd).not.toContain("Task Lifecycle Protocol");
		expect(cmd).not.toContain("--prompt");
	});
});

describe("resolveAgentCommand — positional prompt separator (-- guard)", () => {
	// Regression: GitHub #570. Task descriptions starting with "---" (markdown
	// frontmatter, horizontal rules) were treated as long options by the
	// agent CLI (commander/clap/yargs) and the agent process exited immediately
	// with "error: unknown option '---…'". A literal "--" before the positional
	// prompt terminates option parsing.

	it.each(["claude", "codex", "gemini", "agent"])(
		"%s: emits `-- <prompt>` so a '---'-prefixed description is not parsed as a flag",
		async (baseCmd) => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: baseCmd }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
			baseCmd === "claude" ? { sessionId: "11111111-1111-1111-1111-111111111111" } : undefined,
		);

		// Codex / Cursor agents append skill bodies onto the prompt, so we
		// match the prefix `-- '---hello frontmatter` (no closing quote).
		expect(cmd).toContain("-- '---hello frontmatter");
		// The prompt token must not be at the head of args where it could be
		// scanned as an option — it must come strictly after the "--" guard.
		const dashDashIdx = cmd.indexOf(" -- '");
		const promptIdx = cmd.indexOf("'---hello frontmatter");
		expect(dashDashIdx).toBeGreaterThan(0);
		expect(promptIdx).toBeGreaterThan(dashDashIdx);
		},
	);

	it("OpenCode: uses --prompt <value>, so no -- separator is added (value form is unambiguous)", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
		);

		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("'---hello frontmatter");
		expect(cmd).not.toMatch(/ -- '/);
	});

	it("OpenCode resolves a V2 session spec only when its agent opts into V2", async () => {
		const config = makeConfig({ model: "openai/gpt-5" });
		const v1 = await resolveAgentCommandDetails(makeAgent({ baseCommand: "opencode" }), config, makeCtx());
		expect(v1.openCodeLaunch).toBeUndefined();
		expect(v1.command).toContain("--model openai/gpt-5 --prompt");

		const v2 = await resolveAgentCommandDetails(makeAgent({ baseCommand: "opencode", opencodeProtocol: "v2" }), config, makeCtx());
		expect(v2.command).toBe("opencode");
		expect(v2.openCodeLaunch).toMatchObject({ model: { providerID: "openai", id: "gpt-5" }, prompt: expect.stringContaining("Fix the login bug") });
	});

	it("does not add -- when resuming (no positional prompt is emitted on resume)", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
			{ resume: true, sessionId: "11111111-1111-1111-1111-111111111111" },
		);

		expect(cmd).not.toContain("---hello frontmatter");
		expect(cmd).not.toMatch(/ -- '/);
	});
});

describe("resolveAgentCommand — sessionId", () => {
	it("Gemini: injects --session-id for fresh launch (PR #26060)", async () => {
		const cmd = await resolveAgentCommand(
			makeAgent({ baseCommand: "gemini" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ sessionId: "gem-fresh" },
		);

		expect(cmd).toContain("--session-id gem-fresh");
		expect(cmd).not.toContain("--resume");
	});
});

describe("supportsPreAssignedSessionId", () => {
	it.each([
		["claude", true],
		["agent", true],
		["gemini", true],
		["codex", false],
		["bash", false],
		["opencode", false],
	])("%s → %s", (cmd, expected) => {
		expect(supportsPreAssignedSessionId(cmd)).toBe(expected);
	});
});

describe("buildResumeCommand", () => {
	it("works with full paths", () => {
		expect(buildResumeCommand("/usr/local/bin/claude", "sid-5")).toBe("/usr/local/bin/claude --resume sid-5");
	});
});

describe("applyBinaryPathOverride", () => {
	let dir: string;
	let claudePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-agents-test-"));
		claudePath = join(dir, "claude");
		writeFileSync(claudePath, "#!/bin/sh\n", { mode: 0o755 });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("applies the auto-cached path only while it still names the same, existing binary", () => {
		expect(applyBinaryPathOverride(makeAgent({ baseCommand: "claude" }), { "test-agent": claudePath }).baseCommand, "same binary")
			.toBe(claudePath);
		expect(applyBinaryPathOverride(makeAgent({ baseCommand: "claude-codex" }), { "test-agent": claudePath }).baseCommand, "base command edited")
			.toBe("claude-codex");
		expect(applyBinaryPathOverride(makeAgent({ baseCommand: "claude" }), { "test-agent": join(dir, "gone") }).baseCommand, "cached path gone")
			.toBe("claude");
	});

	it("fails the launch when the user's path is missing or not executable instead of using the system binary", () => {
		const agent = makeAgent({ baseCommand: "claude", name: "Claude Code" });
		const missing = join(dir, "gone");
		expect(() => applyBinaryPathOverride(agent, { "test-agent": claudePath }, { "test-agent": missing })).toThrow(
			`Custom executable for agent "Claude Code" not found or not executable: ${missing}`,
		);
		const plain = join(dir, "plain");
		writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
		expect(() => applyBinaryPathOverride(makeAgent({ baseCommand: "claude" }), undefined, { "test-agent": plain })).toThrow(/not executable/);
	});

	it("applies a differently named user-chosen path, ahead of the auto-cached one", () => {
		const wrapper = join(dir, "claude-wrapper");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude" });
		expect(applyBinaryPathOverride(agent, undefined, { "test-agent": wrapper }).baseCommand, "user path only").toBe(wrapper);
		expect(applyBinaryPathOverride(agent, { "test-agent": claudePath }, { "test-agent": wrapper }).baseCommand, "user beats cached")
			.toBe(wrapper);
	});

	// The reported bug: pointing built-in Claude at a differently named binary
	// re-guessed the CLI from the new file name, turning it into an unknown agent
	// that lost resume, hooks and the dev3 protocol. The user only said WHERE the
	// binary is, never that it is a different agent.
	it("keeps the agent's CLI identity when the path renames the binary", () => {
		const wrapper = join(dir, "my-claude");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, undefined, { "test-agent": wrapper });
		expect(result.baseCommand).toBe(wrapper);
		expect(result.agentFamily).toBe("claude");
		expect(supportsResume(result.baseCommand, result.agentFamily)).toBe(true);
		expect(supportsPreAssignedSessionId(result.baseCommand, result.agentFamily)).toBe(true);
	});

	it("never overrides a declared family, and leaves it unset when the original command was unrecognized too", () => {
		const wrapper = join(dir, "my-claude");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const declared = makeAgent({ baseCommand: "claude", agentFamily: "none" });
		expect(applyBinaryPathOverride(declared, undefined, { "test-agent": wrapper }).agentFamily, "declared").toBe("none");

		// Pinning "none" here would be worse than today: the path's own name still
		// deserves its chance (e.g. a custom agent pointed at the real `claude`).
		const real = join(dir, "claude");
		const agent = makeAgent({ baseCommand: "some-wrapper" });
		const result = applyBinaryPathOverride(agent, undefined, { "test-agent": real });
		expect(result.agentFamily).toBeUndefined();
		expect(supportsResume(result.baseCommand, result.agentFamily)).toBe(true);
	});
});

// A custom executable for Claude Code must run through the very same code as
// `claude` itself — the whole point of declaring the family.
describe("a declared family reaches the launch command", () => {
	it("resumes, mints session ids and injects the protocol + bypass switch, like plain claude", async () => {
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		const resumed = await resolveAgentCommand(agent, makeConfig(), makeCtx(), { resume: true, sessionId: "sess-1" });
		expect(resumed, "resume").toContain("my-claude --resume sess-1");
		expect(resumed, "resume does not re-send the description").not.toContain("Fix the login bug");

		expect(await resolveAgentCommand(agent, makeConfig(), makeCtx(), { sessionId: "fresh-1" }), "fresh launch")
			.toContain("--session-id fresh-1");
		expect(buildResumeCommand("my-claude", "sess-1", "claude")).toBe("my-claude --resume sess-1");

		const fresh = await resolveAgentCommand(agent, makeConfig(), makeCtx());
		expect(fresh, "protocol").toContain("--append-system-prompt");
		expect(fresh, "bypass switch").toContain("--allow-dangerously-skip-permissions");
	});

	it("still applies the Claude-only model override", () => {
		const config = makeConfig({ model: "claude-opus-5[1m]" });
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		const result = resolveLaunchConfig(config, agent, "my-claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "pinned-opus" });
		expect(result?.model).toBe("pinned-opus");
	});

	it("leaves an undeclared custom binary on the generic path", async () => {
		const agent = makeAgent({ baseCommand: "my-claude" });
		const cmd = await resolveAgentCommand(agent, makeConfig(), makeCtx(), { resume: true, sessionId: "sess-1" });
		expect(cmd).not.toContain("--resume");
		expect(cmd).toContain("Fix the login bug");
	});
});

// `hooksIntegration` declared a wrapper's HOOK family only; `agentFamily` now
// governs the whole adapter. Same three values, wider reach — carried over in
// place so a user who already declared his wrapper gains resume for free.
describe("migrateOldFormat — hooksIntegration becomes agentFamily", () => {
	it("carries the declared family (and the explicit opt-out) over and drops the old key", () => {
		const [agent, optOut] = migrateOldFormat([
			{ id: "a", name: "Wrapper", baseCommand: "my-claude", configurations: [], hooksIntegration: "claude" },
			{ id: "b", name: "W", baseCommand: "claude", configurations: [], hooksIntegration: "none" },
		]) as any[];
		expect(agent.agentFamily).toBe("claude");
		expect("hooksIntegration" in agent).toBe(false);
		expect(optOut.agentFamily, "opt-out").toBe("none");
	});

	it("leaves an undeclared agent alone, and lets an already-migrated value win over a stale old key", () => {
		const [undeclared, migrated] = migrateOldFormat([
			{ id: "a", name: "Claude", baseCommand: "claude", configurations: [] },
			{ id: "b", name: "W", baseCommand: "x", configurations: [], hooksIntegration: "codex", agentFamily: "claude" },
		]) as any[];
		expect(undeclared.agentFamily, "undeclared").toBeUndefined();
		expect(migrated.agentFamily, "already migrated").toBe("claude");
		expect("hooksIntegration" in migrated).toBe(false);
	});

});

describe("mergeWithDefaults — preserves user-defined order", () => {
	it("returns DEFAULT_AGENTS as-is when no stored agents", () => {
		const result = mergeWithDefaults([]);
		expect(result.map((a) => a.id)).toEqual(DEFAULT_AGENTS.map((a) => a.id));
	});

	it("preserves user-reordered agents and configurations", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const moved = ["claude-plan", "claude-plan-sonnet5", "claude-default"];
		const reorderedConfigs = [
			...moved.map((id) => claude.configurations.find((c) => c.id === id)!),
			...claude.configurations.filter((c) => !moved.includes(c.id)),
		];
		// User dragged Codex above Claude and reversed a few Claude configs.
		const result = mergeWithDefaults([{ ...codex }, { ...claude, configurations: reorderedConfigs }]);
		expect(result.slice(0, 2).map((a) => a.id), "agent order").toEqual(["builtin-codex", "builtin-claude"]);
		expect(result[1].configurations.slice(0, 3).map((c) => c.id), "config order").toEqual(moved);
	});

	it("appends newly added default agents and configurations without disturbing stored order", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		// Stored has Codex, then Claude with only its first 3 configs (older snapshot).
		const result = mergeWithDefaults([{ ...codex }, { ...claude, configurations: claude.configurations.slice(0, 3) }]);
		expect(result[0].id).toBe("builtin-codex");
		for (const def of DEFAULT_AGENTS) {
			expect(result.some((a) => a.id === def.id), `agent ${def.id}`).toBe(true);
		}
		const claudeResult = result.find((a) => a.id === "builtin-claude")!;
		expect(claudeResult.configurations.slice(0, 3).map((c) => c.id)).toEqual(claude.configurations.slice(0, 3).map((c) => c.id));
		for (const def of claude.configurations) {
			expect(claudeResult.configurations.some((c) => c.id === def.id), `config ${def.id}`).toBe(true);
		}
	});

	it("drops superseded prerelease GPT-5.6 preset ids", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const interimIds = [
			"codex-5.6-heavy-bypass",
			"codex-5.6-heavy",
			"codex-5.6-medium-bypass",
			"codex-5.6-medium",
			"codex-5.6-terra-xhigh",
			"codex-5.6-luna-low-bypass",
			"codex-5.6-luna-low",
		];
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [
				...codex.configurations,
				...interimIds.map((id) => ({ id, name: id, model: "gpt-5.6-sol" })),
			],
		}];

		const mergedCodex = mergeWithDefaults(stored).find((agent) => agent.id === "builtin-codex")!;
		expect(mergedCodex.configurations.some((config) => interimIds.includes(config.id))).toBe(false);
	});

	describe("retired Cursor preset models", () => {
		const cursorDef = () => DEFAULT_AGENTS.find((a) => a.id === "builtin-cursor")!;

		/** A stored board as it looked before the refresh, with the shipped values
		 *  of the day, plus whatever extra configurations a test needs. */
		function storedCursor(configs: AgentConfiguration[]): CodingAgent[] {
			return [{ ...cursorDef(), configurations: configs }];
		}
		function mergedCursor(stored: CodingAgent[]) {
			return mergeWithDefaults(stored).find((a) => a.id === "builtin-cursor")!;
		}

		it("refreshes a stale shipped model onto the current default", () => {
			const merged = mergedCursor(storedCursor([
				{ id: "cursor-default", name: "Default (Opus 4.6)", model: "opus-4.6-thinking" },
				{ id: "cursor-gpt", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex-high" },
				{ id: "cursor-gemini", name: "Gemini 3.1 Pro", model: "gemini-3.1-pro" },
			]));

			expect(merged.configurations.find((c) => c.id === "cursor-default")?.model).toBe("claude-opus-5-thinking-high");
			expect(merged.configurations.find((c) => c.id === "cursor-gpt")?.model).toBe("gpt-5.6-sol-xhigh");
			expect(merged.configurations.find((c) => c.id === "cursor-gemini")?.model).toBe("gemini-3.7-flash-high");
		});

		it("keeps the user's own edits: a hand-picked model, a renamed preset, a user-created config", () => {
			const merged = mergedCursor(storedCursor([
				{ id: "cursor-default", name: "My Cursor", model: "opus-4.6-thinking" },
				{ id: "cursor-gpt", name: "GPT-5.3 Codex High", model: "cursor-grok-4.6-xhigh" },
				{ id: "my-own-preset", name: "Mine", model: "opus-4.6-thinking" },
			]));
			const byId = (id: string) => merged.configurations.find((c) => c.id === id)!;

			expect(byId("cursor-gpt").model, "hand-picked model").toBe("cursor-grok-4.6-xhigh");
			expect(byId("cursor-default").name, "renamed preset keeps its name").toBe("My Cursor");
			expect(byId("cursor-default").model, "renamed preset still drops the dead model").toBe("claude-opus-5-thinking-high");
			expect(byId("my-own-preset"), "user-created config").toMatchObject({ name: "Mine", model: "opus-4.6-thinking" });
		});

		it("is idempotent — a second load changes nothing", () => {
			const once = mergedCursor(storedCursor([
				{ id: "cursor-default", name: "Default (Opus 4.6)", model: "opus-4.6-thinking" },
				{ id: "cursor-yolo", name: "Renamed", model: "composer-2.5" },
				{ id: "my-own-preset", name: "Mine", model: "opus-4.6-thinking" },
			]));
			const twice = mergedCursor([once]);

			expect(twice.configurations).toEqual(once.configurations);
		});

		it("no Cursor preset carries a version, so no bump can overwrite a user's edits", () => {
			expect(cursorDef().configurations.every((c) => c.version === undefined)).toBe(true);
		});
	});

	it("upgrades the Luna-era Codex default to the current default and leads the Astra rows with it", () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [
				codex.configurations.find((config) => config.model === "gpt-5.6-sol")!,
				{
					id: "codex-default", name: "GPT-5.6 Luna Bypass [X-High] — Default",
					model: "gpt-5.6-luna", version: 9,
					additionalArgs: ["-c", 'model_reasoning_effort="xhigh"'],
				},
			],
		}];
		const updated = applyLayoutResync(mergeWithDefaults(stored))
			.find((agent) => agent.id === "builtin-codex")!;
		const firstAstra = updated.configurations.find((config) => config.model === "gpt-6-astra")!;
		expect(firstAstra.id).toBe(updated.defaultConfigId);
		expect(firstAstra.additionalArgs).toContain('model_reasoning_effort="medium"');
		expect(updated.configurations.find((config) => config.id === "codex-5.6-luna-xhigh-bypass")?.model)
			.toBe("gpt-5.6-luna");
	});

	it("moves the one-release GPT-6 Sol default back to GPT-6 Astra Medium and retires the duplicate Astra row", () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [
				{
					id: "codex-default", name: "GPT-6 Sol Bypass [Medium] — Default",
					model: "gpt-6-sol", groupLabel: "GPT-6 Sol", version: 11,
					additionalArgs: ["-c", 'model_reasoning_effort="medium"'],
				},
				{ id: "codex-6-astra-medium-bypass", name: "GPT-6 Astra Bypass [Medium]", model: "gpt-6-astra", version: 3 },
				{ ...codex.configurations.find((config) => config.id === "codex-6-sol-high-bypass")!, envVars: { KEEP: "1" } },
			],
		}];
		const updated = applyLayoutResync(mergeWithDefaults(stored))
			.find((agent) => agent.id === "builtin-codex")!;
		const firstAstra = updated.configurations.find((config) => config.model === "gpt-6-astra")!;
		expect(firstAstra.id).toBe(updated.defaultConfigId);
		expect(firstAstra).toMatchObject({
			groupLabel: "GPT-6 Astra", name: "GPT-6 Astra Bypass [Medium] — Default",
		});
		expect(firstAstra.additionalArgs).toContain('model_reasoning_effort="medium"');
		expect(updated.configurations.some((config) => config.id === "codex-6-astra-medium-bypass")).toBe(false);
		// An explicit Sol pick keeps its model and the user's own override.
		expect(updated.configurations.find((config) => config.id === "codex-6-sol-high-bypass"))
			.toMatchObject({ model: "gpt-6-sol", envVars: { KEEP: "1" } });
		expect(updated.configurations.find((config) => config.id === "codex-6-sol-medium-bypass")?.model).toBe("gpt-6-sol");
		expect(updated.configurations.find((config) => config.id === "codex-plan")?.model).toBe("gpt-6-sol");
	});

	it("keeps GPT-6.x Sol and Luna selectable next to the Astra default, and launches each when chosen", async () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const models = new Set(codex.configurations.map((config) => config.model));
		expect(models.has("gpt-6.2-astra")).toBe(true);
		expect(models.has("gpt-6.2-sol")).toBe(true);
		expect(models.has("gpt-6.1-sol")).toBe(true);
		expect(models.has("gpt-6-sol")).toBe(true);
		expect(models.has("gpt-6-luna")).toBe(true);
		expect(findConfig(codex, undefined)?.model).toBe("gpt-6-astra");
		expect(findConfig(codex, "codex-6.2-astra-medium-bypass")?.model).toBe("gpt-6.2-astra");
		expect(findConfig(codex, "codex-6.2-sol-medium-bypass")?.model).toBe("gpt-6.2-sol");
		expect(findConfig(codex, "codex-6.1-sol-medium-bypass")?.model).toBe("gpt-6.1-sol");
		expect(findConfig(codex, "codex-6-sol-medium-bypass")?.model).toBe("gpt-6-sol");
		expect(findConfig(codex, "codex-6-luna-medium-bypass")?.model).toBe("gpt-6-luna");
		// A task stored on the retired duplicate row lands on the Astra default, not the first row.
		expect(findConfig(codex, "codex-6-astra-medium-bypass")?.id).toBe("codex-default");

		// …and launches GPT-6 Astra by default, the others when chosen.
		const omitted = await resolveAgentCommand(codex, findConfig(codex, undefined), makeCtx());
		expect(omitted).toContain("gpt-6-astra");
		expect(omitted).not.toContain("gpt-6.2-");
		expect(omitted).not.toContain("gpt-6.1-sol");
		const explicitAstra = await resolveAgentCommand(codex, findConfig(codex, "codex-6.2-astra-high-bypass"), makeCtx());
		expect(explicitAstra).toContain("gpt-6.2-astra");
		expect(explicitAstra).toContain('model_reasoning_effort="high"');
		const explicitSol62 = await resolveAgentCommand(codex, findConfig(codex, "codex-6.2-sol-medium"), makeCtx());
		expect(explicitSol62).toContain("gpt-6.2-sol");
		expect(explicitSol62).not.toContain("gpt-6-astra");
		expect(omitted).not.toContain("gpt-6-sol");
		const explicitNewSol = await resolveAgentCommand(codex, findConfig(codex, "codex-6.1-sol-medium-bypass"), makeCtx());
		expect(explicitNewSol).toContain("gpt-6.1-sol");
		expect(explicitNewSol).not.toContain("gpt-6-astra");
		const explicitSol = await resolveAgentCommand(codex, findConfig(codex, "codex-6-sol-medium-bypass"), makeCtx());
		expect(explicitSol).toContain("gpt-6-sol");
		expect(explicitSol).not.toContain("gpt-6-astra");
	});

	it("ships canonical model labels on every Codex preset", () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const expectedLabels: Record<string, string> = {
			"gpt-6.2-astra": "GPT-6.2 Astra",
			"gpt-6.2-sol": "GPT-6.2 Sol",
			"gpt-6.1-sol": "GPT-6.1 Sol",
			"gpt-6-sol": "GPT-6 Sol",
			"gpt-6-astra": "GPT-6 Astra",
			"gpt-6-luna": "GPT-6 Luna",
			"gpt-5.6-sol": "GPT-5.6 Sol",
			"gpt-5.6-terra": "GPT-5.6 Terra",
			"gpt-5.6-luna": "GPT-5.6 Luna",
			"gpt-5.5": "GPT-5.5",
		};

		for (const config of codex.configurations) {
			expect(config.groupLabel).toBe(expectedLabels[config.model!]);
		}
	});

	it("refreshes presentation labels when a built-in preset version increases", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const currentDefault = codex.configurations.find((config) => config.id === "codex-default")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [{
				...currentDefault,
				name: "Old default name",
				modeLabel: "Old mode label",
				groupLabel: "Old model label",
				version: (currentDefault.version ?? 1) - 1,
			}],
		}];

		const mergedDefault = mergeWithDefaults(stored)
			.find((agent) => agent.id === "builtin-codex")!
			.configurations.find((config) => config.id === "codex-default")!;
		expect({
			name: mergedDefault.name,
			modeLabel: mergedDefault.modeLabel,
			groupLabel: mergedDefault.groupLabel,
		}).toEqual({
			name: currentDefault.name,
			modeLabel: currentDefault.modeLabel,
			groupLabel: currentDefault.groupLabel,
		});
	});

	it("keeps user-created configurations in their original position", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const userCfg: AgentConfiguration = {
			id: "user-custom-1",
			name: "My Plan Variant",
			model: "sonnet",
			permissionMode: "plan",
		};
		// Place user config between Plan and Bypass groups.
		const planIdx = claude.configurations.findIndex((c) => c.id === "claude-plan-sonnet");
		const stored: CodingAgent[] = [
			{
				...claude,
				configurations: [
					...claude.configurations.slice(0, planIdx + 1),
					userCfg,
					...claude.configurations.slice(planIdx + 1),
				],
			},
		];
		const result = mergeWithDefaults(stored);
		const claudeResult = result.find((a) => a.id === "builtin-claude")!;
		const userIdx = claudeResult.configurations.findIndex((c) => c.id === "user-custom-1");
		const planSonnetIdx = claudeResult.configurations.findIndex((c) => c.id === "claude-plan-sonnet");
		expect(userIdx).toBe(planSonnetIdx + 1);
	});
});

describe("mergeMcpApproval", () => {
	it("defaults to enableAllProjectMcpServers, keeping unrelated worktree settings", () => {
		const result = mergeMcpApproval({}, []);
		expect(result.enableAllProjectMcpServers).toBe(true);
		expect(result.enabledMcpjsonServers).toBeUndefined();
		expect(result.disabledMcpjsonServers).toBeUndefined();
		expect(mergeMcpApproval({}, [null, null]).enableAllProjectMcpServers, "null sources").toBe(true);
		const withPermissions = mergeMcpApproval({ permissions: { allow: ["Bash(ls *)"] } }, []);
		expect(withPermissions.permissions, "unrelated settings").toEqual({ allow: ["Bash(ls *)"] });
		expect(withPermissions.enableAllProjectMcpServers).toBe(true);
	});

	it("respects an explicit enableAll from project sources, the later one winning", () => {
		expect(mergeMcpApproval({}, [{ enableAllProjectMcpServers: false }]).enableAllProjectMcpServers).toBe(false);
		expect(mergeMcpApproval({}, [
			{ enableAllProjectMcpServers: true },
			{ enableAllProjectMcpServers: false },
		]).enableAllProjectMcpServers, "later overrides earlier").toBe(false);
	});

	it("merges enabled/disabled server names from worktree settings and project sources", () => {
		const result = mergeMcpApproval({ enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"] }, [
			{ enabledMcpjsonServers: ["nile-docs", "nile"], disabledMcpjsonServers: ["scary"] },
			{ enabledMcpjsonServers: ["nile-reports"] },
		]);
		expect(result.enabledMcpjsonServers).toEqual(["a", "nile-docs", "nile", "nile-reports"]);
		expect(result.disabledMcpjsonServers).toEqual(["b", "scary"]);
	});

	it("ignores non-string entries in *McpjsonServers arrays", () => {
		const result = mergeMcpApproval({}, [
			{ enabledMcpjsonServers: ["a", 42, null, "b"] as unknown[] },
		]);
		expect(result.enabledMcpjsonServers).toEqual(["a", "b"]);
	});
});

describe("ensureClaudeMcpApproved", () => {
	let tmp: string;
	let worktree: string;
	let outside: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-mcp-approve-"));
		worktree = join(tmp, "worktree");
		outside = join(tmp, "kit");
		mkdirSync(worktree);
		mkdirSync(outside);
		writeFileSync(join(worktree, ".mcp.json"), "{}");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("pre-approves MCP servers in the worktree settings.local.json", () => {
		ensureClaudeMcpApproved(worktree);
		const written = JSON.parse(readFileSync(join(worktree, ".claude", "settings.local.json"), "utf-8"));
		expect(written.enableAllProjectMcpServers).toBe(true);
	});

	it("writes nothing when .claude links outside the worktree", () => {
		symlinkSync(outside, join(worktree, ".claude"));
		ensureClaudeMcpApproved(worktree);
		expect(existsSync(join(outside, "settings.local.json"))).toBe(false);
	});
});

describe("applyLayoutResync", () => {
	it("reorders a stale config order to the current DEFAULT_AGENTS order, user-created configs last", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const custom: AgentConfiguration = { id: "my-custom-config", name: "My Custom" };
		// Simulate a fossilized stored order — reverse of the current declared order.
		const stored: CodingAgent[] = [
			{ ...claude, configurations: [custom, ...[...claude.configurations].reverse()] },
		];

		const ids = applyLayoutResync(stored).find((a) => a.id === "builtin-claude")!.configurations.map((c) => c.id);
		expect(ids[ids.length - 1]).toBe("my-custom-config");
		expect(ids.slice(0, -1)).toEqual(claude.configurations.map((c) => c.id));
	});

	it("leaves fully custom agents untouched", () => {
		const custom = makeAgent({
			id: "my-custom-agent",
			configurations: [{ id: "b", name: "B" }, { id: "a", name: "A" }],
		});
		const result = applyLayoutResync([custom]);
		expect(result[0].configurations.map((c) => c.id)).toEqual(["b", "a"]);
	});
});


describe("applyProviderModel — flag-delivered backends rewrite the model alias", () => {
	const codexOnBedrock = (providerConfig?: CodingAgent["providerConfig"]) =>
		makeAgent({ baseCommand: "codex", llmProvider: "bedrock-codex", providerConfig });

	it("rewrites a codex alias to the mapped Bedrock id; a per-model manual override wins over the map", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		expect(applyProviderModel(config, codexOnBedrock())?.model).toBe("global.openai.gpt-5.6-sol");
		// Original config is not mutated.
		expect(config.model).toBe("gpt-5.6-sol");
		const overridden = applyProviderModel(
			config,
			codexOnBedrock({ "bedrock-codex": { modelOverrides: { "gpt-5.6-sol": "openai.custom" } } }),
		);
		expect(overridden?.model, "manual override").toBe("openai.custom");
	});

	it("does nothing on the native default, for env-delivering backends, or for another agent's provider", () => {
		const codexConfig = makeConfig({ model: "gpt-5.6-sol" });
		expect(applyProviderModel(codexConfig, makeAgent({ baseCommand: "codex" })), "native default").toBe(codexConfig);
		// Claude on Bedrock keeps its alias; --model is omitted instead.
		const claudeConfig = makeConfig({ model: "claude-opus-4-8[1m]" });
		expect(applyProviderModel(claudeConfig, makeAgent({ baseCommand: "claude", llmProvider: "bedrock" })), "env-delivering").toBe(claudeConfig);
		expect(applyProviderModel(codexConfig, makeAgent({ baseCommand: "gemini", llmProvider: "bedrock-codex" })), "other agent").toBe(codexConfig);
	});
});

describe("resolveLaunchConfig — the shared launch-time model pipeline", () => {
	it("runs the provider step, then the session-env model override, and is a no-op otherwise", () => {
		const codexConfig = makeConfig({ model: "gpt-5.6-sol" });
		const bedrock = makeAgent({ baseCommand: "codex", llmProvider: "bedrock-codex" });
		expect(resolveLaunchConfig(codexConfig, bedrock, "codex", {})?.model, "provider step").toBe("global.openai.gpt-5.6-sol");
		const claude = resolveLaunchConfig(makeConfig({ model: "sonnet" }), makeAgent({ baseCommand: "claude" }), "claude", { ANTHROPIC_MODEL: "my-model" });
		expect(claude?.model, "session-env override").toBe("my-model");
		expect(resolveLaunchConfig(codexConfig, makeAgent({ baseCommand: "codex" }), "codex", {}), "native, no env").toBe(codexConfig);
	});
});

describe("applyModelOverride — API profile model beats the preset --model flag", () => {
	it("replaces the preset model when ANTHROPIC_MODEL is in the session env, down to the --model flag", async () => {
		const config = makeConfig({ model: "claude-opus-4-8[1m]" });
		const result = applyModelOverride(config, "claude", { ANTHROPIC_MODEL: "openrouter/custom" });
		expect(result?.model).toBe("openrouter/custom");
		// Original config is not mutated.
		expect(config.model).toBe("claude-opus-4-8[1m]");

		const cmd = await resolveAgentCommand(makeAgent(), applyModelOverride(makeConfig({ model: "sonnet" }), "claude", { ANTHROPIC_MODEL: "my-model" }), makeCtx());
		expect(cmd).toContain("--model my-model");
		expect(cmd).not.toContain("--model sonnet");
	});

	it("does nothing without ANTHROPIC_MODEL, for non-Claude commands, or without a config", () => {
		const config = makeConfig({ model: "sonnet" });
		expect(applyModelOverride(config, "claude", {}), "no env").toBe(config);
		const codexConfig = makeConfig({ model: "gpt-5.5" });
		expect(applyModelOverride(codexConfig, "codex", { ANTHROPIC_MODEL: "my-model" }), "non-Claude").toBe(codexConfig);
		// Env alone wins when no flag is emitted.
		expect(applyModelOverride(undefined, "claude", { ANTHROPIC_MODEL: "my-model" }), "no config").toBeUndefined();
	});

	it("rewrites the preset to the family-slot override, ahead of a bare ANTHROPIC_MODEL", () => {
		// dev3 presets pass concrete ids.
		const opus = applyModelOverride(makeConfig({ model: "claude-opus-4-8[1m]" }), "claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "openrouter/opus-alt" });
		expect(opus?.model).toBe("openrouter/opus-alt");
		const sonnet = applyModelOverride(makeConfig({ model: "claude-sonnet-5" }), "claude", {
			ANTHROPIC_DEFAULT_SONNET_MODEL: "provider/sonnet",
			ANTHROPIC_MODEL: "provider/generic",
		});
		expect(sonnet?.model, "slot beats ANTHROPIC_MODEL").toBe("provider/sonnet");
	});

	it("keeps the preset when the model's family has no override, or the override is an ENV_UNSET sentinel", () => {
		const fable = makeConfig({ model: "claude-fable-5" });
		// Only an opus override is present — fable is untouched, no ANTHROPIC_MODEL fallback.
		expect(applyModelOverride(fable, "claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "x" }), "no family override").toBe(fable);
		// ENV_UNSET means 'unset', not a model id.
		const opus = makeConfig({ model: "claude-opus-4-8[1m]" });
		const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: ENV_UNSET, ANTHROPIC_MODEL: ENV_UNSET };
		expect(applyModelOverride(opus, "claude", env), "ENV_UNSET").toBe(opus);
	});
});

describe("claudeModelFamily", () => {
	it("classifies dev3 preset model ids into alias families", () => {
		expect(claudeModelFamily("claude-opus-4-8[1m]")).toBe("opus");
		expect(claudeModelFamily("claude-sonnet-5")).toBe("sonnet");
		expect(claudeModelFamily("claude-sonnet-5-5")).toBe("sonnet");
		expect(claudeModelFamily("claude-haiku-4-5")).toBe("haiku");
		expect(claudeModelFamily("claude-fable-5")).toBe("fable");
		expect(claudeModelFamily("claude-fable-5-1[1m]")).toBe("fable");
		expect(claudeModelFamily("claude-fable-5-2[1m]")).toBe("fable");
		expect(claudeModelFamily("openrouter/deepseek-v4")).toBeNull();
	});
});

describe("claudeDefaultEnv — Claude's bypass guard under uid 0", () => {
	it("declares the sandbox only when running as root on a non-Windows box, keeping the other defaults", () => {
		expect(claudeDefaultEnv(0, "linux").IS_SANDBOX).toBe("1");
		expect(claudeDefaultEnv(501, "linux").IS_SANDBOX).toBeUndefined();
		expect(claudeDefaultEnv(0, "win32").IS_SANDBOX).toBeUndefined();
		expect(claudeDefaultEnv(undefined, "linux").IS_SANDBOX).toBeUndefined();
		for (const env of [claudeDefaultEnv(0, "linux"), claudeDefaultEnv(501, "darwin")]) {
			expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
			expect(env.CLAUDE_CODE_NO_FLICKER).toBe("1");
		}
	});

	it("reaches a Claude launch's env, and only a Claude one", () => {
		expect(getDefaultEnvForAgent(makeAgent())).toEqual(claudeDefaultEnv());
		expect(getDefaultEnvForAgent(makeAgent({ baseCommand: "codex" }))).toEqual({});
	});

	// omp's completion bell would trip dev3's BEL → user-questions move ahead of
	// the status extension's Stop, stranding every finished turn in Has Questions.
	it("silences omp's terminal notifications, and only omp's", () => {
		expect(getDefaultEnvForAgent(makeAgent({ baseCommand: "omp" }))).toEqual({ PI_NOTIFICATIONS: "off" });
		expect(getDefaultEnvForAgent(makeAgent({ baseCommand: "my-omp", agentFamily: "omp" }))).toEqual({ PI_NOTIFICATIONS: "off" });
		expect(getDefaultEnvForAgent(makeAgent({ baseCommand: "codex" })).PI_NOTIFICATIONS).toBeUndefined();
	});
});
