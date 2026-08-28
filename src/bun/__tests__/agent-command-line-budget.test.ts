import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_COMMAND_LINE_RESERVE,
	AGENT_SKILL_BODY_LIMIT,
	WINDOWS_COMMAND_LINE_LIMIT,
} from "../../shared/agent-command-line-budget";
import { CLAUDE_SKILL_BODY, CODEX_SKILL_BODY, GENERIC_SKILL_BODY } from "../../shared/agent-skill-content";
import { __setCodexProfileV2Override, resolveAgentCommand, type TemplateContext } from "../agents";
import type { CodingAgent } from "../../shared/types";

// ---------------------------------------------------------------------------
// A Windows command line stops at 32 767 characters, and the dev3 protocol
// travels ON it for every agent but Claude. Past the ceiling `CreateProcess`
// refuses with an error naming neither the length nor the argument, so the only
// symptom is "no agent starts on Windows" — which is exactly how it shipped
// (Seq 1737).
//
// Nothing about writing prose in `agent-skill-content.ts` hints at a length
// budget, and POSIX has no comparable limit, so an author on macOS gets no
// signal at all. This file IS that signal. It is a budget guard, not a
// characterization test: if it fails, the prompt got longer, and the fix is to
// cut prose — never to raise the cap.
// ---------------------------------------------------------------------------

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function asPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
});

const BODIES: Array<[name: string, body: string]> = [
	["claude", CLAUDE_SKILL_BODY],
	["codex", CODEX_SKILL_BODY],
	["generic", GENERIC_SKILL_BODY],
];

/**
 * Every agent dev3 can launch, spelled the way its adapter is keyed: the Cursor
 * adapter answers to `agent`, and an unknown command exercises the generic one.
 * A new adapter belongs on this list — an agent nobody measures is an agent that
 * breaks on Windows silently.
 */
const AGENT_COMMANDS = ["claude", "codex", "gemini", "agent", "opencode", "some-custom-agent"];

const agent = (baseCommand: string): CodingAgent => ({
	id: "a",
	name: "A",
	baseCommand,
	configurations: [],
	defaultConfigId: "d",
});

/**
 * A task the user really could write: a long description AND a long append
 * prompt, together filling the reserve exactly. This is the worst case the
 * budget promises to survive, so it is what gets measured — a launch measured
 * with "Fix bug" as its description proves nothing about a real board.
 */
function fullSizeContext(): TemplateContext {
	const half = Math.floor(AGENT_COMMAND_LINE_RESERVE / 2);
	return {
		taskTitle: "Fix the Windows launch",
		taskDescription: "x".repeat(half),
		projectName: "dev-3.0",
		projectPath: "C:\\Users\\John Smith\\src\\dev-3.0",
		worktreePath: "C:\\Users\\John Smith\\.dev3.0\\worktrees\\dev-3.0\\abcd1234\\worktree",
	};
}

describe("the protocol body fits the budget", () => {
	// Both platforms, because the body is not platform-invariant: the PR-footer
	// section is rewritten where `dev3://` is not registered, and the Windows
	// wording is the LONGER one — measuring only on the dev machine reads a
	// number no Windows user ever gets.
	for (const platform of ["darwin", "win32"] as const) {
		for (const [name, ,] of BODIES) {
			it(`${name} on ${platform}`, async () => {
				asPlatform(platform);
				// Re-evaluated per platform: the bodies are composed at module load,
				// and `skillPrLinkInstruction` branches on the platform.
				vi.resetModules();
				const mod = await import("../../shared/agent-skill-content");
				const body = (mod as unknown as Record<string, string>)[`${name.toUpperCase()}_SKILL_BODY`] ?? "";
				expect(body.length).toBeGreaterThan(0);
				expect(body.length).toBeLessThanOrEqual(AGENT_SKILL_BODY_LIMIT);
			});
		}
	}
});

// Claude's protocol reaches it as a FILE on Windows, and that is an
// optimisation which can fail (an unwritable `~/.dev3.0`), in which case the
// launch falls back to the inline body. Mocking the write away measures that
// fallback — the worst case — and keeps the test from writing into the real
// `~/.dev3.0` of whoever runs it.
vi.mock("../agent-system-prompt-file", async () => {
	const actual = await vi.importActual<typeof import("../agent-system-prompt-file")>("../agent-system-prompt-file");
	return { ...actual, ensureAgentSystemPromptFile: () => null };
});

describe("the whole Windows command line fits", () => {
	for (const command of AGENT_COMMANDS) {
		it(`${command} launches inside the ceiling with a full-size task`, () => {
			asPlatform("win32");
			__setCodexProfileV2Override(false);
			try {
				const cmd = resolveAgentCommand(agent(command), undefined, fullSizeContext());
				expect(cmd.length).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
			} finally {
				__setCodexProfileV2Override(null);
			}
		});
	}

	it("the reserve is real: a task text this long is what the budget is for", () => {
		expect(fullSizeContext().taskDescription.length * 2).toBeLessThanOrEqual(AGENT_COMMAND_LINE_RESERVE);
		expect(AGENT_SKILL_BODY_LIMIT + AGENT_COMMAND_LINE_RESERVE).toBe(WINDOWS_COMMAND_LINE_LIMIT);
	});
});
