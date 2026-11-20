import { afterEach, describe, expect, it, vi } from "vitest";
import { PANE_INPUT_LIMITS } from "../../shared/pane-input";
import {
	getAgentAdapter,
	autoAgentFamily,
	isKnownAgentCommand,
	KNOWN_AGENT_COMMANDS,
	SELECTABLE_AGENT_FAMILIES,
	hasAgentAdapter,
	agentKey,
	claudeAdapter,
	codexAdapter,
	geminiAdapter,
	cursorAdapter,
	opencodeAdapter,
	copilotAdapter,
	ompAdapter,
	piAdapter,
	agyAdapter,
	agySessionSettings,
	genericAdapter,
	shellEscape,
	type AdapterLaunchOptions,
	type TemplateContext,
} from "../../shared/agent-adapters";
import { DEV3_AUTO_APPROVED_SUBCOMMANDS } from "../../shared/agent-hooks";
import { AGY_SKILL_BODY, CLAUDE_SKILL_BODY, CODEX_SKILL_BODY, GENERIC_SKILL_BODY, OMP_SKILL_BODY, PI_SKILL_BODY } from "../../shared/agent-skill-content";
import { DEFAULT_AGENTS, type AgentConfiguration } from "../../shared/types";

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
		.split(shellEscape(OMP_SKILL_BODY)).join("<OMP_BODY>")
		.split(shellEscape(PI_SKILL_BODY)).join("<PI_BODY>")
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
		expect(getAgentAdapter("/Users/me/.local/bin/copilot")).toBe(copilotAdapter);
		expect(getAgentAdapter("omp")).toBe(ompAdapter);
		expect(getAgentAdapter("pi")).toBe(piAdapter);
		expect(getAgentAdapter("/home/u/.local/bin/pi")).toBe(piAdapter);
		expect(getAgentAdapter("/Users/me/.local/bin/agy")).toBe(agyAdapter);
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

// The renderer discloses what "Auto" resolves to and warns about an
// unrecognized command, but importing this registry into the app bundle would
// drag every skill body (~32 KB) along — so families.ts restates those facts as
// plain data. These are the tests that keep the copy honest.
describe("agent families (the renderer's copy of the registry)", () => {
	const ADAPTERS = [claudeAdapter, codexAdapter, geminiAdapter, cursorAdapter, opencodeAdapter, copilotAdapter, ompAdapter, piAdapter, agyAdapter];

	it("lists exactly the commands that have a first-class adapter", () => {
		expect([...KNOWN_AGENT_COMMANDS].sort()).toEqual(ADAPTERS.map((a) => a.command).sort());
		for (const adapter of ADAPTERS) expect(isKnownAgentCommand(adapter.command)).toBe(true);
		expect(isKnownAgentCommand("my-claude")).toBe(false);
		expect(isKnownAgentCommand("")).toBe(false);
	});

	it("offers every known command plus the explicit opt-out", () => {
		expect([...SELECTABLE_AGENT_FAMILIES].sort()).toEqual([...ADAPTERS.map((a) => a.command), "none"].sort());
	});

	it("resolves each adapter's own command, and nothing else", () => {
		for (const adapter of ADAPTERS) {
			expect(autoAgentFamily(adapter.command)).toBe(adapter.command);
			expect(autoAgentFamily(`/opt/bin/${adapter.command}`)).toBe(adapter.command);
		}
		expect(autoAgentFamily("my-claude")).toBe("none");
	});
});

describe("a declared family overrides the command-name guess", () => {
	it("keeps the name guess when nothing is declared", () => {
		expect(getAgentAdapter("claude")).toBe(claudeAdapter);
		expect(getAgentAdapter("/opt/homebrew/bin/codex")).toBe(codexAdapter);
		expect(getAgentAdapter("my-claude")).toBe(genericAdapter);
	});

	it("treats a renamed binary as the CLI it declares", () => {
		// The reported bug: a custom executable for Claude Code was handled as an
		// unknown CLI — no hooks, no dev3 protocol, and Resume Session re-ran the
		// task description instead of continuing the conversation.
		expect(getAgentAdapter("my-claude-wrapper", "claude")).toBe(claudeAdapter);
		expect(getAgentAdapter("/Users/x/bin/cc", "claude")).toBe(claudeAdapter);
		expect(getAgentAdapter("", "codex")).toBe(codexAdapter);
		expect(hasAgentAdapter("my-claude-wrapper", "claude")).toBe(true);
		expect(agentKey("/Users/x/bin/cc", "claude")).toBe("claude");
	});

	it("gives a declared wrapper the same resume support as the CLI itself", () => {
		const adapter = getAgentAdapter("my-claude", "claude");
		expect(adapter.supportsResume).toBe(true);
		expect(adapter.supportsPreAssignedSessionId).toBe(true);
		expect(adapter.buildResumeCommand("my-claude", "abc")).toBe("my-claude --resume abc");
		expect(adapter.transcriptStore?.("/w", ["/home/.claude"])).toEqual(
			claudeAdapter.transcriptStore?.("/w", ["/home/.claude"]),
		);
	});

	it("resumes rather than re-sending the prompt, unlike the generic fallback", () => {
		const ctx: TemplateContext = {
			taskTitle: "T",
			taskDescription: "ORIGINAL PROMPT",
			projectName: "p",
			projectPath: "/p",
			worktreePath: "/w",
		};
		const resume: AdapterLaunchOptions = { resume: true, sessionId: "sess-1" };
		const declared = getAgentAdapter("my-claude", "claude").launchArgs("my-claude", undefined, ctx, resume).join(" ");
		expect(declared).toContain("--resume sess-1");
		expect(declared).not.toContain("ORIGINAL PROMPT");
		// Without the declaration this is byte-identical to a fresh launch.
		expect(getAgentAdapter("my-claude").launchArgs("my-claude", undefined, ctx, resume).join(" "))
			.toContain("ORIGINAL PROMPT");
	});

	it("threads stopTarget / permissionMode through the declared family", () => {
		expect(getAgentAdapter("wrapper", "claude").hooksSpec({ stopTarget: "review-by-ai", permissionMode: "plan" }))
			.toEqual({ kind: "claude", stopTarget: "review-by-ai", permissionMode: "plan" });
	});

	it("honours an explicit opt-out even for a recognized command", () => {
		expect(getAgentAdapter("claude", "none")).toBe(genericAdapter);
		expect(hasAgentAdapter("claude", "none")).toBe(false);
	});
});

describe("capability flags", () => {
	it.each([
		[claudeAdapter, "claude", true, true],
		[codexAdapter, "codex", true, false],
		[geminiAdapter, "gemini", true, true],
		[cursorAdapter, "agent", true, true],
		[opencodeAdapter, "opencode", true, false],
		[copilotAdapter, "copilot", true, true],
		[ompAdapter, "omp", true, false],
		[piAdapter, "pi", true, true],
		[agyAdapter, "agy", true, false],
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
		[copilotAdapter, ["claude", "copilot"]],
		[ompAdapter, ["claude"]],
		[piAdapter, ["claude"]],
		[agyAdapter, ["claude"]],
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
	it("Copilot is a bare copilot spec", () => {
		expect(copilotAdapter.hooksSpec()).toEqual({ kind: "copilot" });
	});
	it("omp is a bare omp spec (the executor turns it into --hook <extension>)", () => {
		expect(ompAdapter.hooksSpec()).toEqual({ kind: "omp" });
	});
	it("pi is a bare pi spec (the executor turns it into --extension <extension>)", () => {
		expect(piAdapter.hooksSpec()).toEqual({ kind: "pi" });
	});
	it("agy is a bare agy spec (the executor writes the worktree .agents/ config)", () => {
		expect(agyAdapter.hooksSpec()).toEqual({ kind: "agy" });
	});
	it("Cursor installs accounting hooks while keeping its generic lifecycle prompt", () => {
		expect(cursorAdapter.hooksSpec()).toEqual({ kind: "cursor" });
		expect(cursorAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
	});
	it("Gemini / OpenCode / Generic install no hooks", () => {
		expect(geminiAdapter.hooksSpec()).toBeNull();
		expect(opencodeAdapter.hooksSpec()).toBeNull();
		expect(genericAdapter.hooksSpec()).toBeNull();
	});
});

describe("hooksReportPermissionWaits", () => {
	it.each([claudeAdapter, codexAdapter, ompAdapter, piAdapter, agyAdapter])(
		"$command hooks move the task to user-questions on a permission wait",
		(adapter) => expect(adapter.hooksReportPermissionWaits).toBe(true),
	);
	it.each([copilotAdapter, cursorAdapter, geminiAdapter, opencodeAdapter, genericAdapter])(
		"$command hooks do not report a permission wait (none, or no user-questions move)",
		(adapter) => expect(adapter.hooksReportPermissionWaits).toBe(false),
	);
});

describe("exitProgram", () => {
	it.each([
		[claudeAdapter, "/exit"],
		[codexAdapter, "/quit"],
		[geminiAdapter, "/quit"],
		[cursorAdapter, "/exit"],
		[opencodeAdapter, "/exit"],
		[copilotAdapter, "/exit"],
		[piAdapter, "/quit"],
		[agyAdapter, "/quit"],
	] as const)("%s interrupts, types its quit command, then submits", (adapter, command) => {
		const program = adapter.exitProgram();
		expect(program).not.toBeNull();
		expect(program!.map((stage) => stage.steps)).toEqual([
			[{ kind: "key", key: "ctrl-c" }],
			[{ kind: "text", text: command }],
			[{ kind: "key", key: "enter" }],
		]);
		// The gaps are what let the CLI redraw before the command and see a discrete Enter.
		expect(program![0]!.delayBeforeMs).toBeUndefined();
		expect(program![1]!.delayBeforeMs).toBeGreaterThan(0);
		expect(program![2]!.delayBeforeMs).toBeGreaterThan(0);
		// Must stay inside the pane-input seam's in-band delay budget or the send is refused.
		const totalDelay = program!.reduce((sum, stage) => sum + (stage.delayBeforeMs ?? 0), 0);
		expect(totalDelay).toBeLessThanOrEqual(PANE_INPUT_LIMITS.maxTotalDelayMs);
	});
	it("an unknown CLI has no quit command", () => {
		expect(genericAdapter.exitProgram()).toBeNull();
	});
});

describe("buildResumeCommand", () => {
	it.each([
		[claudeAdapter, "claude", undefined, "claude --continue"],
		[claudeAdapter, "claude", "sid", "claude --resume sid"],
		[codexAdapter, "codex", undefined, null],
		[codexAdapter, "codex", "sid", "codex resume sid -c check_for_update_on_startup=false"],
		[geminiAdapter, "gemini", undefined, "gemini --resume latest"],
		[geminiAdapter, "gemini", "sid", "gemini --resume sid"],
		[cursorAdapter, "agent", undefined, "agent --continue"],
		[cursorAdapter, "agent", "sid", "agent --resume sid"],
		[opencodeAdapter, "opencode", undefined, "opencode --continue"],
		[opencodeAdapter, "opencode", "sid", "opencode --session sid"],
		[copilotAdapter, "copilot", undefined, "copilot --continue"],
		[copilotAdapter, "copilot", "sid", "copilot --resume=sid"],
		[ompAdapter, "omp", undefined, "omp -c"],
		[ompAdapter, "omp", "sid", "omp --resume sid"],
		[piAdapter, "pi", undefined, "pi -c"],
		[piAdapter, "pi", "0199aaaa-bbbb-7ccc", "pi --session-id 0199aaaa-bbbb-7ccc"],
		[agyAdapter, "agy", undefined, "agy --continue"],
		[agyAdapter, "agy", "c0ffee-1", "agy --conversation c0ffee-1"],
		[genericAdapter, "aider", "sid", null],
	] as const)("%s (sid=%s)", (adapter, base, sid, expected) => {
		expect(adapter.buildResumeCommand(base, sid ?? undefined)).toBe(expected);
	});
});

describe("skillBody", () => {
	it("each adapter carries the right body", () => {
		expect(claudeAdapter.skillBody).toBe(CLAUDE_SKILL_BODY);
		expect(codexAdapter.skillBody).toBe(CODEX_SKILL_BODY);
		expect(ompAdapter.skillBody).toBe(OMP_SKILL_BODY);
		expect(piAdapter.skillBody).toBe(PI_SKILL_BODY);
		// Gemini/Cursor/OpenCode/Generic use the generic body.
		expect(geminiAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(cursorAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(opencodeAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(copilotAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
		expect(genericAdapter.skillBody).toBe(GENERIC_SKILL_BODY);
	});
});

describe("launchArgs — Claude", () => {
	it("fresh: model + system prompt + positional prompt", () => {
		expect(launch("claude", cfg({ model: "sonnet" })))
			.toBe("claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'");
	});
	it("resume with sessionId drops the prompt", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { resume: true, sessionId: "sid" }))
			.toBe("claude --resume sid --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY>");
	});
	it("skipModelForProvider omits --model", () => {
		expect(launch("claude", cfg({ model: "claude-opus-4-8[1m]" }), { skipModelForProvider: true }))
			.toBe("claude --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'");
	});
	it("skipSystemPrompt omits the body", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { skipSystemPrompt: true }))
			.toBe("claude --model sonnet --allow-dangerously-skip-permissions -- 'Fix the login bug'");
	});
	it("statusline settings after the body, unless user passes --settings", () => {
		expect(launch("claude", cfg({ model: "sonnet" }), { statuslineSettingsFile: "/tmp/s.json" }))
			.toBe("claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> --settings /tmp/s.json -- 'Fix the login bug'");
		expect(launch("claude", cfg({ model: "sonnet", additionalArgs: ["--settings", "x"] }), { statuslineSettingsFile: "/tmp/s.json" }))
			.toBe("claude --model sonnet --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> --settings x -- 'Fix the login bug'");
	});
	it("always adds --allow-dangerously-skip-permissions, but never duplicates a bypass flag", () => {
		// Auto/Plan (no bypass flag) → adapter injects the allow flag.
		expect(launch("claude", cfg({ model: "sonnet", permissionMode: "acceptEdits" })))
			.toBe("claude --model sonnet --permission-mode acceptEdits --allow-dangerously-skip-permissions --append-system-prompt <CLAUDE_BODY> -- 'Fix the login bug'");
		// Preset already carries the hard flag (via additionalArgs, appended after
		// the system prompt) → adapter does NOT inject --allow- on top of it.
		expect(launch("claude", cfg({ model: "sonnet", additionalArgs: ["--dangerously-skip-permissions"] })))
			.toBe("claude --model sonnet --append-system-prompt <CLAUDE_BODY> --dangerously-skip-permissions -- 'Fix the login bug'");
		// Preset already carries the allow flag → keep exactly one (no duplicate).
		expect(launch("claude", cfg({ model: "sonnet", additionalArgs: ["--allow-dangerously-skip-permissions"] })))
			.toBe("claude --model sonnet --append-system-prompt <CLAUDE_BODY> --allow-dangerously-skip-permissions -- 'Fix the login bug'");
	});
});

describe("launchArgs — Codex", () => {
	it("theme + developer_instructions + resume subcommand", () => {
		expect(launch("codex", cfg({ model: "gpt-5.6-sol" }), { codex: CODEX_RT }))
			.toBe("codex --model gpt-5.6-sol -c 'default_permissions=\"dev3\"' --profile dev3-dark -c 'tui.theme=\"dracula\"' -c check_for_update_on_startup=false -c <CODEX_DEV_INSTR> -- 'Fix the login bug'");
		expect(launch("codex", cfg({ model: "gpt-5.6-sol" }), { resume: true, sessionId: "sid", codex: CODEX_RT }))
			.toBe("codex resume sid --model gpt-5.6-sol -c 'default_permissions=\"dev3\"' --profile dev3-dark -c 'tui.theme=\"dracula\"' -c check_for_update_on_startup=false -c <CODEX_DEV_INSTR>");
	});
	it("rewrites a dev3 profile to the themed profile", () => {
		expect(launch("codex", cfg({ model: "gpt-5.6-sol", additionalArgs: ["-p", "dev3"] }), { codex: CODEX_RT }))
			.toBe("codex --model gpt-5.6-sol -p dev3-dark -c 'default_permissions=\"dev3\"' -c 'tui.theme=\"dracula\"' -c check_for_update_on_startup=false -c <CODEX_DEV_INSTR> -- 'Fix the login bug'");
	});

	// A preset built by hand carries no flags at all. Codex's own default
	// permissions do not include ~/.dev3.0, so without this the agent runs but
	// `dev3 current` dies with EPERM and the task's status never moves.
	describe("a preset that decides nothing still reaches dev3", () => {
		it("adds the dev3 permissions preset", () => {
			expect(launch("codex", cfg({}), { codex: CODEX_RT })).toContain(`-c 'default_permissions="dev3"'`);
		});

		it("adds the dev3 profile, which is where the hook trust lives", () => {
			expect(launch("codex", cfg({}), { codex: CODEX_RT })).toContain("--profile dev3-dark");
		});

		it("adds it with the flag the installed codex actually accepts", () => {
			expect(launch("codex", cfg({}), { codex: { ...CODEX_RT, profileLaunchFlag: "--profile-v2" } }))
				.toContain("--profile-v2 dev3-dark");
		});

		it("adds them to a model-roles preset too, which has flags for the model and nothing else", () => {
			const command = launch("codex", cfg({ model: "openrouter/ds-flash-0731" }), { codex: CODEX_RT });
			expect(command).toContain(`-c 'default_permissions="dev3"'`);
			expect(command).toContain("--profile dev3-dark");
		});
	});

	// Deciding permissions is the user's call; only the absence of a decision is
	// dev3's to fill. Each of these means "I chose", so nothing gets added.
	describe("a preset that decided for itself is left alone", () => {
		it.each([
			["a full-access sandbox", ["--sandbox", "danger-full-access"]],
			["a short-flag sandbox", ["-s", "read-only"]],
			["the bypass flag", ["--dangerously-bypass-approvals-and-sandbox"]],
			// Shorthand for a sandbox choice, so it is a choice.
			["the full-auto shorthand", ["--full-auto"]],
			["its own permissions preset", ["-c", 'default_permissions="myown"']],
			["a raw sandbox_mode override", ["-c", 'sandbox_mode="read-only"']],
		])("%s", (_name, additionalArgs) => {
			expect(launch("codex", cfg({ additionalArgs }), { codex: CODEX_RT }))
				.not.toContain(`-c 'default_permissions="dev3"'`);
		});

		// An approval flag says when Codex stops to ask, not what it may touch.
		// Dropping the dev3 preset there would cost the agent `~/.dev3.0` for no
		// reason, so this one still gets it.
		it("still supplies permissions next to an approval-only flag", () => {
			expect(launch("codex", cfg({ additionalArgs: ["--ask-for-approval", "on-failure"] }), { codex: CODEX_RT }))
				.toContain(`-c 'default_permissions="dev3"'`);
		});

		it("keeps the user's own profile instead of forcing ours", () => {
			const command = launch("codex", cfg({ additionalArgs: ["-p", "myprofile"] }), { codex: CODEX_RT });
			expect(command).toContain("-p myprofile");
			expect(command).not.toContain("dev3-dark");
		});

		// Codex takes `--flag=value` as readily as `--flag value`; a check that only
		// knows the spaced form silently overrides a choice the user did make.
		it.each([
			["a sandbox written with =", ["--sandbox=danger-full-access"]],
			["a short-flag sandbox written with =", ["-s=read-only"]],
		])("%s", (_name, additionalArgs) => {
			expect(launch("codex", cfg({ additionalArgs }), { codex: CODEX_RT }))
				.not.toContain(`-c 'default_permissions="dev3"'`);
		});

		it("keeps a profile written with = instead of appending ours", () => {
			const command = launch("codex", cfg({ additionalArgs: ["--profile=myprofile"] }), { codex: CODEX_RT });
			expect(command).toContain("--profile=myprofile");
			expect(command).not.toContain("dev3-dark");
		});
	});

	it("rewrites a dev3 profile written with = to the themed profile", () => {
		expect(launch("codex", cfg({ additionalArgs: ["--profile=dev3"] }), { codex: CODEX_RT }))
			.toContain("--profile=dev3-dark");
		expect(launch("codex", cfg({ additionalArgs: ["-p=dev3"] }), { codex: { ...CODEX_RT, profileLaunchFlag: "--profile-v2" } }))
			.toContain("--profile-v2=dev3-dark");
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

describe("launchArgs — Copilot", () => {
	it("fresh: model, mode, effort, and the prompt via -i (stays interactive)", () => {
		expect(launch("copilot", cfg({ model: "gpt-5.6-sol", permissionMode: "bypassPermissions", effort: "high" })))
			.toBe("copilot --model gpt-5.6-sol --allow-all --effort high -i 'Fix the login bug'");
	});
	// `copilot --model auto --effort xhigh` exits with
	// `Model "auto" does not support reasoning effort configuration` and never
	// starts, so a pane built that way would die on open.
	it("drops --effort on the auto model, which refuses to launch with it", () => {
		expect(launch("copilot", cfg({ model: "auto", effort: "xhigh" })))
			.toBe("copilot --model auto -i 'Fix the login bug'");
	});
	it("pre-assigns a session id on a fresh launch and resumes with --resume=", () => {
		expect(launch("copilot", cfg({ model: "auto" }), { sessionId: "sid" }))
			.toBe("copilot --session-id sid --model auto -i 'Fix the login bug'");
		expect(launch("copilot", cfg({ model: "auto" }), { resume: true, sessionId: "sid" }))
			.toBe("copilot --resume=sid --model auto");
	});
	it("carries no skill body on the command line — the sessionStart hook delivers it", () => {
		expect(launch("copilot", cfg())).toBe("copilot -i 'Fix the login bug'");
	});
	it("maps every dev3 permission mode to Copilot's own flags", () => {
		expect(launch("copilot", cfg({ permissionMode: "plan" }))).toBe("copilot --mode plan -i 'Fix the login bug'");
		expect(launch("copilot", cfg({ permissionMode: "acceptEdits" }))).toBe("copilot --allow-tool write -i 'Fix the login bug'");
		expect(launch("copilot", cfg({ permissionMode: "auto" }))).toBe("copilot --allow-all-tools -i 'Fix the login bug'");
		expect(launch("copilot", cfg({ permissionMode: "dontAsk" })))
			.toBe("copilot --allow-all-tools --no-ask-user -i 'Fix the login bug'");
		expect(launch("copilot", cfg({ permissionMode: "default" }))).toBe("copilot -i 'Fix the login bug'");
	});
	it("drops maxBudgetUsd — Copilot budgets in AI credits, not dollars", () => {
		expect(launch("copilot", cfg({ maxBudgetUsd: 12 }))).toBe("copilot -i 'Fix the login bug'");
	});
});

describe("launchArgs — agy", () => {
	/** The one `--settings` argument, parsed back out of its shell quoting. */
	function sessionSettings(args: string[]): Record<string, any> {
		const raw = args[args.indexOf("--settings") + 1]!;
		return JSON.parse(raw.slice(1, -1).replaceAll("'\\''", "'"));
	}
	const SETTINGS = `--settings ${shellEscape(agySessionSettings("/path/to/worktree"))}`;

	it("fresh: the prompt via -i (stays interactive) and no protocol on the command line", () => {
		expect(launch("agy", cfg())).toBe(`agy ${SETTINGS} -i 'Fix the login bug'`);
	});
	it("fresh: model, effort, permission flag, then settings, then the user's own args, then the prompt", () => {
		expect(launch("agy", cfg({ model: "gemini-4-neon-high", effort: "high", permissionMode: "acceptEdits", additionalArgs: ["--add-dir", "/x"] })))
			.toBe(`agy --model gemini-4-neon-high --effort high --mode accept-edits ${SETTINGS} --add-dir /x -i 'Fix the login bug'`);
	});
	it("passes no --effort unless the preset sets one: effort is part of the model slug", () => {
		expect(launch("agy", cfg({ model: "gemini-4-neon-high" }))).not.toContain("--effort");
	});
	it("quotes a model name that carries spaces and parentheses", () => {
		expect(launch("agy", cfg({ model: "Gemini 4 Neon (High)" })))
			.toBe(`agy --model 'Gemini 4 Neon (High)' ${SETTINGS} -i 'Fix the login bug'`);
	});
	it("quotes a conversation id that is not a plain token, on launch and on resume", () => {
		expect(launch("agy", cfg(), { resume: true, sessionId: "a b;c" })).toContain("--conversation 'a b;c' ");
		expect(agyAdapter.buildResumeCommand!("agy", "a b;c")).toBe("agy --conversation 'a b;c'");
		expect(agyAdapter.buildResumeCommand!("agy", "ok-1.2_x")).toBe("agy --conversation ok-1.2_x");
	});
	it("maps every dev3 permission mode to agy's own flags", () => {
		const flags = (permissionMode: AgentConfiguration["permissionMode"]) => launch("agy", cfg({ permissionMode })).split(` ${SETTINGS}`)[0];
		expect(flags("acceptEdits")).toBe("agy --mode accept-edits");
		expect(flags("plan")).toBe("agy --mode plan");
		expect(flags("auto")).toBe("agy --mode auto");
		expect(flags("bypassPermissions")).toBe("agy --dangerously-skip-permissions");
		expect(flags("dontAsk")).toBe("agy --dangerously-skip-permissions");
		expect(flags("default")).toBe("agy");
	});
	it("resumes by conversation id, or the most recent one, with no prompt", () => {
		expect(launch("agy", cfg({ model: "m" }), { resume: true, sessionId: "abc-123" }))
			.toBe(`agy --conversation abc-123 --model m ${SETTINGS}`);
		expect(launch("agy", cfg(), { resume: true })).toBe(`agy --continue ${SETTINGS}`);
	});

	describe("the per-session --settings", () => {
		it("never asks agy for the terminal bell: it rings at every turn end and fought the Stop hook", () => {
			for (const resume of [false, true]) {
				expect(sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX, { resume }))).not.toHaveProperty("notifications");
			}
		});
		it("trusts the worktree, on fresh and resumed launches alike", () => {
			const ctx = { ...CTX, worktreePath: "/w/with space/it's" };
			for (const resume of [false, true]) {
				const settings = sessionSettings(agyAdapter.launchArgs("agy", cfg(), ctx, { resume }));
				expect(settings.trustedWorkspaces).toEqual(["/w/with space/it's"]);
			}
		});
		it("trusts the worktree's REALPATH when the backend resolved one: agy ignores /tmp, it matches /private/tmp", () => {
			const ctx = { ...CTX, worktreePath: "/tmp/wt" };
			const settings = sessionSettings(agyAdapter.launchArgs("agy", cfg(), ctx, { agy: { worktreeRealPath: "/private/tmp/wt" } }));
			expect(settings.trustedWorkspaces).toEqual(["/private/tmp/wt"]);
		});
		it("leaves the trusted workspaces out when the launch has no worktree path", () => {
			const settings = sessionSettings(agyAdapter.launchArgs("agy", cfg(), { ...CTX, worktreePath: "" }));
			expect(settings).not.toHaveProperty("trustedWorkspaces");
			expect(settings.permissions).toBeDefined();
		});
		it("allows exactly the auto-approved dev3 metadata subcommands, one rule per word-prefix and spelling", () => {
			const { allow } = sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX)).permissions;
			expect(allow).toEqual(["dev3", "~/.dev3.0/bin/dev3"].flatMap((cli) => DEV3_AUTO_APPROVED_SUBCOMMANDS.map((sub) => `command(${cli} ${sub})`)));
			expect(allow).toContain("command(dev3 note)");
			expect(allow).toContain("command(dev3 projects list)");
			// Whatever starts a process stays behind agy's own prompt.
			for (const rule of ["command(dev3 pane run)", "command(dev3 dev-server start)", "command(dev3 agent spawn)", "command(dev3 remote)"]) {
				expect(allow).not.toContain(rule);
			}
		});
		it("also allows the account-home absolute spelling the agent types after reading a hook command", () => {
			const { allow } = sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX, { agy: { accountHome: "/Users/me/" } })).permissions;
			expect(allow).toContain("command(/Users/me/.dev3.0/bin/dev3 overview)");
			expect(allow).toContain("command(dev3 overview)");
			expect(allow).toContain("command(/Users/me/.dev3.0/bin/dev3 projects list)");
			expect(allow).not.toContain("command(/Users/me/.dev3.0/bin/dev3 pane run)");
			// `~` points into a launcher's HOME once the account home is known.
			expect(allow.some((rule: string) => rule.includes("~"))).toBe(false);
			expect(allow).toHaveLength(DEV3_AUTO_APPROVED_SUBCOMMANDS.length * 2);
		});
		it("reports quota and permission waits through a silent statusLine stacked under agy's own", () => {
			const { statusLine } = sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX));
			expect(statusLine.stack_with_default).toBe(true);
			expect(statusLine.command).toBe(`sh -c '[ -z "$DEV3_TASK_ID" ] || exec ~/.dev3.0/bin/dev3 statusline agy'`);
		});
		it("runs the CLI by an absolute path under the account home the backend gives: a launcher's HOME redirects ~", () => {
			const { statusLine } = sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX, { agy: { accountHome: "/Users/me" } }));
			expect(statusLine.command).toBe(`sh -c '[ -z "$DEV3_TASK_ID" ] || exec /Users/me/.dev3.0/bin/dev3 statusline agy'`);
		});
		it("keeps quota out of the dump while rate-limit tracking is off", () => {
			const { statusLine } = sessionSettings(agyAdapter.launchArgs("agy", cfg(), CTX, { agy: { trackRateLimits: false } }));
			expect(statusLine.command).toContain("statusline agy --no-limits");
		});
		it("comes before the user's own args, so a later --settings of theirs wins", () => {
			const args = agyAdapter.launchArgs("agy", cfg({ additionalArgs: ["--add-dir", "/x"] }), CTX);
			expect(args.indexOf("--settings")).toBeLessThan(args.indexOf("--add-dir"));
		});
	});

	it("drops maxBudgetUsd — agy has no budget flag", () => {
		expect(launch("agy", cfg({ maxBudgetUsd: 12 }))).toBe(`agy ${SETTINGS} -i 'Fix the login bug'`);
	});
	it("carries a wrapper's declared family: the same adapter on a renamed command", () => {
		const args = getAgentAdapter("my-agy-launcher", "agy").launchArgs("my-agy-launcher", cfg(), CTX);
		expect(args[0]).toBe("my-agy-launcher");
		expect(args).toContain("-i");
	});
	it("renders its own skill body: hook-aware status, no approval-wait claim", () => {
		expect(agyAdapter.skillBody).toBe(AGY_SKILL_BODY);
		expect(AGY_SKILL_BODY).toContain("native hooks into every agy pane");
		expect(AGY_SKILL_BODY).toContain("tool approval waits → `user-questions`");
		expect(AGY_SKILL_BODY).not.toContain("bell");
	});
});

describe("agy presets", () => {
	const agy = DEFAULT_AGENTS.find((a) => a.id === "builtin-agy")!;
	const byId = (id: string) => agy.configurations.find((c) => c.id === id)!;

	it("follows the Claude scheme: 'Mode (Model, Effort)', model without effort, effort and mode as fields", () => {
		expect(byId("agy-auto-neon-high")).toMatchObject({ name: "Auto (Neon, High)", model: "gemini-4-neon", effort: "high", permissionMode: "auto" });
		expect(byId("agy-bypass-hydrogen-xhigh")).toMatchObject({ name: "Bypass (Hydrogen, X-High)", model: "gemini-4-hydrogen", effort: "xhigh", permissionMode: "bypassPermissions" });
		expect(byId("agy-plan-carbon-high")).toMatchObject({ name: "Plan (Carbon, High)", permissionMode: "plan" });
		expect(byId("agy-approvals-argon-high")).toMatchObject({ name: "Accept Edits (Argon, High)", permissionMode: "acceptEdits" });
		expect(byId("agy-default-neon-high")).toMatchObject({ name: "Default (Neon, High)", model: "gemini-4-neon" });
		expect(byId("agy-default-neon-high").permissionMode).toBeUndefined();
		expect(agy.defaultConfigId).toBe("agy-auto-neon-high");
	});
	it("offers each model's own efforts in Auto and Bypass, and High once in the other modes", () => {
		const efforts = (prefix: string) => agy.configurations.filter((c) => c.id.startsWith(prefix)).map((c) => c.effort);
		expect(efforts("agy-auto-neon-")).toEqual(["low", "medium", "high", "xhigh"]);
		expect(efforts("agy-auto-carbon-")).toEqual(["low", "medium", "high"]);
		expect(efforts("agy-bypass-argon-")).toEqual(["low", "medium", "high"]);
		expect(efforts("agy-bypass-hydrogen-")).toEqual(["low", "medium", "high", "xhigh"]);
		for (const mode of ["default", "plan", "approvals"]) expect(agy.configurations.filter((c) => c.id.startsWith(`agy-${mode}-`))).toHaveLength(4);
		expect(new Set(agy.configurations.map((c) => c.id)).size).toBe(agy.configurations.length);
		expect(agy.configurations.some((c) => /gemini/i.test(c.name))).toBe(false);
	});
	it("launches with the alias, --effort and the mode flag, and no additional args", () => {
		const args = (id: string) => launch("agy", byId(id)).split(" --settings ")[0];
		expect(args("agy-auto-neon-low")).toBe("agy --model gemini-4-neon --effort low --mode auto");
		expect(args("agy-bypass-carbon-medium")).toBe("agy --model gemini-4-carbon --effort medium --dangerously-skip-permissions");
		expect(args("agy-approvals-argon-high")).toBe("agy --model gemini-4-argon --effort high --mode accept-edits");
		expect(args("agy-plan-hydrogen-high")).toBe("agy --model gemini-4-hydrogen --effort high --mode plan");
		expect(args("agy-default-neon-high")).toBe("agy --model gemini-4-neon --effort high");
		expect(agy.configurations.every((c) => !c.additionalArgs)).toBe(true);
	});
	it("matches the account's `agy models` slugs, which carry an effort the preset does not", () => {
		const probe = agyAdapter.modelListProbe!;
		const available = new Set(probe.parse("gemini-4-neon-high   Gemini 4 Neon (High)\ngemini-4-neon-low   Gemini 4 Neon (Low)\n")!.map(probe.normalize!));
		expect(available.has(probe.normalize!(byId("agy-auto-neon-high").model!))).toBe(true);
		expect(available.has(probe.normalize!(byId("agy-auto-carbon-high").model!))).toBe(false);
	});
});

describe("agy modelListProbe", () => {
	const probe = agyAdapter.modelListProbe!;
	const OUTPUT = [
		"gemini-4-neon-high             Gemini 4 Neon (High)",
		"gemini-pro-orchestrator-neon   Orchestrator (Neon)",
		"claude-opus-5-5-high   Claude Opus 5.5 (High)",
		"",
	].join("\n");

	it("lists the slugs, one per line, by the first token", () => {
		expect(probe.args).toEqual(["models"]);
		expect(probe.parse(OUTPUT)).toEqual(["gemini-4-neon-high", "gemini-pro-orchestrator-neon", "claude-opus-5-5-high"]);
	});
	it("skips a header and colour codes, and answers null when nothing parses", () => {
		expect(probe.parse("Available models:\n\u001B[1mgemini-4-neon-high\u001B[0m   Neon (High)\n")).toEqual(["gemini-4-neon-high"]);
		expect(probe.parse("")).toBeNull();
		expect(probe.parse("Error: not signed in\n")).toBeNull();
	});
	it("compares on the model family: a preset's effort tier does not hide it", () => {
		const normalize = probe.normalize!;
		expect(normalize("gemini-4-neon-high")).toBe("gemini-4-neon");
		expect(normalize("gemini-4-neon-xhigh")).toBe("gemini-4-neon");
		expect(normalize("claude-opus-5-5-max")).toBe("claude-opus-5-5");
		expect(normalize("gemini-pro-orchestrator-neon")).toBe("gemini-pro-orchestrator-neon");
		expect(normalize("gemini-4-neon")).toBe("gemini-4-neon");
	});
});

describe("launchArgs — omp", () => {
	it("omp maps permission mode to its approval tiers", () => {
		expect(launch("omp", cfg({ permissionMode: "acceptEdits" })))
			.toBe("omp --approval-mode write --append-system-prompt <OMP_BODY> -- 'Fix the login bug'");
		expect(launch("omp", cfg({ permissionMode: "bypassPermissions" })))
			.toBe("omp --approval-mode yolo --append-system-prompt <OMP_BODY> -- 'Fix the login bug'");
		expect(launch("omp", cfg({ permissionMode: "dontAsk" })))
			.toBe("omp --approval-mode yolo --append-system-prompt <OMP_BODY> -- 'Fix the login bug'");
	});
	// With no flag omp runs at its configured tier — `yolo` out of the box — so
	// "no mapping" must never mean "no flag". The modes without a tier of their
	// own (plan has no launch flag on omp, auto has no classifier) fail closed.
	it("omp says always-ask for default, plan and auto instead of inheriting yolo", () => {
		for (const permissionMode of ["default", "plan", "auto"] as const) {
			expect(launch("omp", cfg({ permissionMode })))
				.toBe("omp --approval-mode always-ask --append-system-prompt <OMP_BODY> -- 'Fix the login bug'");
		}
		expect(launch("omp", cfg())).toContain("--approval-mode always-ask");
	});
	it("omp keeps a --approval-mode or --thinking the preset already carries, undoubled", () => {
		expect(launch("omp", cfg({ permissionMode: "acceptEdits", additionalArgs: ["--approval-mode", "yolo"] })))
			.toBe("omp --append-system-prompt <OMP_BODY> --approval-mode yolo -- 'Fix the login bug'");
		expect(launch("omp", cfg({ effort: "high", additionalArgs: ["--thinking", "max"] })))
			.toBe("omp --approval-mode always-ask --append-system-prompt <OMP_BODY> --thinking max -- 'Fix the login bug'");
		expect(launch("omp", cfg({ effort: "high", additionalArgs: ["--thinking=max"] })))
			.toBe("omp --approval-mode always-ask --append-system-prompt <OMP_BODY> --thinking=max -- 'Fix the login bug'");
	});
	it("omp carries effort as --thinking and drops maxBudgetUsd, which it has no flag for", () => {
		expect(launch("omp", cfg({ model: "opus", effort: "xhigh", maxBudgetUsd: 5 })))
			.toBe("omp --model opus --approval-mode always-ask --thinking xhigh --append-system-prompt <OMP_BODY> -- 'Fix the login bug'");
	});
	it("omp takes the protocol as a file when the backend wrote one", () => {
		// Same flag, either form. Keeping the body out of argv is what stops
		// `pkill -f` matching every agent (h0x91b/dev-3.0#1734).
		const cmd = launch("omp", cfg(), { systemPromptFile: "/home/u/.dev3.0/data/agent-prompts/omp.md" });
		expect(cmd).toBe("omp --approval-mode always-ask --append-system-prompt /home/u/.dev3.0/data/agent-prompts/omp.md -- 'Fix the login bug'");
		expect(cmd).not.toContain("<OMP_BODY>");
	});
	// omp's session file keeps no appended system prompt: a resume without the
	// flag ran with no dev3 protocol (verified on omp, 2026-10-23).
	it("resumes without re-sending the prompt, but with the protocol and the approval tier", () => {
		expect(launch("omp", cfg(), { resume: true })).toBe("omp -c --approval-mode always-ask --append-system-prompt <OMP_BODY>");
		expect(launch("omp", cfg({ model: "sonnet", permissionMode: "bypassPermissions" }), { resume: true, sessionId: "sid" }))
			.toBe("omp --resume sid --model sonnet --approval-mode yolo --append-system-prompt <OMP_BODY>");
	});
});

describe("launchArgs — pi", () => {
	it("fresh: pins the session id, carries effort as --thinking, prompt after --", () => {
		expect(launch("pi", cfg({ model: "anthropic/claude-sonnet-5", effort: "high" }), { sessionId: "sid-1" }))
			.toBe("pi --session-id sid-1 --model anthropic/claude-sonnet-5 --thinking high --append-system-prompt <PI_BODY> -- 'Fix the login bug'");
	});
	it("emits no approval or budget flag: plain pi has neither", () => {
		for (const permissionMode of ["default", "plan", "auto", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
			const cmd = launch("pi", cfg({ permissionMode, maxBudgetUsd: 5 }));
			expect(cmd).toBe("pi --append-system-prompt <PI_BODY> -- 'Fix the login bug'");
		}
	});
	it("takes the protocol as a file when the backend wrote one", () => {
		const cmd = launch("pi", cfg(), { systemPromptFile: "/home/u/.dev3.0/data/agent-prompts/pi.md" });
		expect(cmd).toBe("pi --append-system-prompt /home/u/.dev3.0/data/agent-prompts/pi.md -- 'Fix the login bug'");
		expect(cmd).not.toContain("<PI_BODY>");
	});
	it("resumes the pinned session, or the latest one, without the prompt but with the protocol", () => {
		expect(launch("pi", cfg({ model: "m" }), { resume: true, sessionId: "sid-1" })).toBe("pi --session-id sid-1 --model m --append-system-prompt <PI_BODY>");
		expect(launch("pi", cfg(), { resume: true })).toBe("pi -c --append-system-prompt <PI_BODY>");
	});
	it("keeps a description that opens with @ from being read as a file to attach", () => {
		const cmd = getAgentAdapter("pi").launchArgs("pi", cfg(), { ...CTX, taskDescription: "@src/a.ts is broken" }).join(" ");
		expect(cmd.endsWith("-- ' @src/a.ts is broken'")).toBe(true);
	});
	it("puts the preset's own args before the prompt, after dev3's", () => {
		expect(launch("pi", cfg({ additionalArgs: ["--provider", "openai"] })))
			.toBe("pi --append-system-prompt <PI_BODY> --provider openai -- 'Fix the login bug'");
	});
});

describe("launchArgs — provider routing args (registry promise)", () => {
	// The llm-provider registry promises that a backend's enableArgs reach the
	// launch with no adapter special-casing. Pin it for EVERY adapter so a future
	// backend (e.g. one for gemini) can't silently drop its routing args.
	it.each(["claude", "codex", "gemini", "agent", "opencode", "aider"])(
		"%s emits options.providerArgs (shell-quoted)",
		(base) => {
			const cmd = launch(base, cfg({ model: undefined }), {
				providerArgs: ["-c", 'model_provider="amazon-bedrock-runtime"'],
			});
			expect(cmd).toContain(`-c 'model_provider="amazon-bedrock-runtime"'`);
		},
	);

	it("Codex places providerArgs BEFORE additionalArgs so a user -c override wins (last-wins)", () => {
		const cmd = launch(
			"codex",
			cfg({ model: undefined, additionalArgs: ["-c", 'model_provider="my-own"'] }),
			{ providerArgs: ["-c", 'model_provider="amazon-bedrock-runtime"'] },
		);
		const injected = cmd.indexOf('model_provider="amazon-bedrock-runtime"');
		const user = cmd.indexOf('model_provider="my-own"');
		expect(injected).toBeGreaterThan(-1);
		expect(user).toBeGreaterThan(injected);
	});
});

describe("agy allow rules on Windows", () => {
	const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	afterEach(() => {
		if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
		vi.resetModules();
	});

	it("spell the CLI as the absolute dev3.exe the hooks use, and never as a POSIX path", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		vi.resetModules();
		const mod = await import("../../shared/agent-adapters/agy");
		const settings = JSON.parse(mod.agySessionSettings("C:/wt", { accountHome: "C:/Users/me" }));
		const allow: string[] = settings.permissions.allow;
		expect(allow).toContain("command(dev3 overview)");
		expect(allow.some((rule) => rule.includes(".exe"))).toBe(true);
		expect(allow.some((rule) => rule.includes("~") || rule.includes("/.dev3.0/bin/dev3 "))).toBe(false);
		expect(JSON.parse(mod.agySessionSettings("C:/wt")).permissions.allow.some((rule: string) => rule.includes("~"))).toBe(false);
	});
});
