import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setCodexProfileV2Override, resolveAgentCommand, type TemplateContext } from "../agents";
import { AGENT_PROMPTS_DIR } from "../agent-system-prompt-file";
import type { CodingAgent } from "../../shared/types";
import {
	CLAUDE_LEAN_SKILL_BODY,
	CLAUDE_SKILL_BODY,
	CODEX_LEAN_SKILL_BODY,
	CODEX_SKILL_BODY,
	GENERIC_LEAN_SKILL_BODY,
	GENERIC_SKILL_BODY,
	OMP_LEAN_SKILL_BODY,
	OMP_SKILL_BODY,
	leanProtocolReference,
} from "../../shared/agent-skill-content";

// DEV3_LEAN_PROTOCOL=1 swaps the injected protocol for its hard-rule sections plus
// a pointer to the full body on disk. Off by default, the launch must not change.

const CTX: TemplateContext = {
	taskTitle: "Fix bug",
	taskDescription: "Fix the login bug",
	projectName: "my-project",
	projectPath: "/path/to/project",
	worktreePath: "/path/to/worktree",
};

const agent = (baseCommand: string): CodingAgent => ({
	id: "a",
	name: "A",
	baseCommand,
	configurations: [],
	defaultConfigId: "d",
});

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const realLean = process.env.DEV3_LEAN_PROTOCOL;

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	if (realLean === undefined) delete process.env.DEV3_LEAN_PROTOCOL;
	else process.env.DEV3_LEAN_PROTOCOL = realLean;
	__setCodexProfileV2Override(null);
});

function onPosix(): void {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	__setCodexProfileV2Override(false);
}

function promptFileOf(cmd: string): string {
	const match = cmd.match(/--append-system-prompt-file '?([^' ]+)'?/);
	if (!match?.[1]) throw new Error(`no prompt file in: ${cmd.slice(0, 300)}`);
	return match[1];
}

const LEAN_PAIRS: Array<[name: string, lean: string, full: string]> = [
	["claude", CLAUDE_LEAN_SKILL_BODY, CLAUDE_SKILL_BODY],
	["codex", CODEX_LEAN_SKILL_BODY, CODEX_SKILL_BODY],
	["omp", OMP_LEAN_SKILL_BODY, OMP_SKILL_BODY],
	["generic", GENERIC_LEAN_SKILL_BODY, GENERIC_SKILL_BODY],
];

describe("lean protocol bodies", () => {
	for (const [name, lean, full] of LEAN_PAIRS) {
		it(`${name}: every line is taken verbatim from the full body`, () => {
			const fullLines = new Set(full.split("\n"));
			const invented = lean.split("\n").filter((line) => !fullLines.has(line));
			expect(invented).toEqual([]);
		});

		it(`${name}: keeps the rules that bind before any lookup`, () => {
			for (const rule of [
				"This worktree already IS your isolation.",
				"## In-task Bug Hunter isolation",
				"## Session-start checklist",
				"## Branch naming",
				"**Respect user-edited titles.**",
				"**Do NOT set or change a priority on your own initiative**",
				"**Never promote or demote a task on your own initiative",
				"## Task status management",
				"**Preservation gate (mandatory):**",
				"## Overview (MANDATORY)",
				"## Scratch tasks",
			]) {
				expect(lean, rule).toContain(rule);
			}
		});

		it(`${name}: is under 40% of the full body`, () => {
			expect(lean.length).toBeLessThan(full.length * 0.4);
		});
	}

	it("the reference names the full protocol file and the CLI help", () => {
		const reference = leanProtocolReference("/home/u/.dev3.0/data/agent-prompts/codex.md");
		expect(reference).toContain("`/home/u/.dev3.0/data/agent-prompts/codex.md`");
		expect(reference).toContain("`dev3 --help`");
	});
});

describe("launching with DEV3_LEAN_PROTOCOL", () => {
	it("off by default: Claude reads the full body, as before", async () => {
		onPosix();
		delete process.env.DEV3_LEAN_PROTOCOL;
		const cmd = await resolveAgentCommand(agent("claude"), undefined, CTX);
		const file = promptFileOf(cmd);
		expect(file).toBe(join(AGENT_PROMPTS_DIR, "claude.md"));
		expect(readFileSync(file, "utf-8")).toBe(CLAUDE_SKILL_BODY);
	});

	it("a value other than 1 leaves the full body in place", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "true";
		const cmd = await resolveAgentCommand(agent("codex"), undefined, CTX);
		expect(cmd).toContain("## Dev Server Control");
		expect(cmd).not.toContain("## Full protocol reference");
	});

	it("Claude gets the lean file, which points at the full one", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "1";
		const cmd = await resolveAgentCommand(agent("claude"), undefined, CTX);
		const file = promptFileOf(cmd);
		expect(file).toBe(join(AGENT_PROMPTS_DIR, "claude-lean.md"));
		const fullPath = join(AGENT_PROMPTS_DIR, "claude.md");
		expect(readFileSync(file, "utf-8")).toBe(CLAUDE_LEAN_SKILL_BODY + leanProtocolReference(fullPath));
		expect(readFileSync(fullPath, "utf-8")).toBe(CLAUDE_SKILL_BODY);
	});

	it("Codex gets the lean body as developer instructions", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "1";
		const cmd = await resolveAgentCommand(agent("codex"), undefined, CTX);
		expect(cmd).toContain("## Full protocol reference");
		expect(cmd).toContain(join(AGENT_PROMPTS_DIR, "codex.md"));
		expect(cmd).not.toContain("## Dev Server Control");
		expect(readFileSync(join(AGENT_PROMPTS_DIR, "codex.md"), "utf-8")).toBe(CODEX_SKILL_BODY);
	});

	it("OpenCode gets the lean body after the task prompt", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "1";
		const cmd = await resolveAgentCommand(agent("opencode"), undefined, CTX);
		expect(cmd).toContain("Fix the login bug");
		expect(cmd).toContain("## Full protocol reference");
		expect(cmd).not.toContain("## Dev Server Control");
	});

	it("skipSystemPrompt still injects nothing", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "1";
		const cmd = await resolveAgentCommand(agent("claude"), undefined, CTX, { skipSystemPrompt: true });
		expect(cmd).not.toContain("--append-system-prompt");
	});
});
