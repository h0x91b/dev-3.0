import { afterEach, describe, expect, it } from "vitest";
import { launchDialect, powerShellNativeArg } from "../../shared/platform-launch";
import { commandToken, shellEscape } from "../../shared/agent-adapters/shell";
import { resolveAgentCommand, buildResumeCommand, DEV3_SYSTEM_PROMPT, type TemplateContext } from "../agents";
import type { CodingAgent } from "../../shared/types";
import { claudeAdapter } from "../../shared/agent-adapters/claude";
import { CLAUDE_SKILL_BODY } from "../../shared/agent-skill-content";
import { systemPromptNeedsFile, WINDOWS_COMMAND_LINE_LIMIT } from "../agent-system-prompt-file";

// ---------------------------------------------------------------------------
// The agent command line is TEXT that a generated wrapper script re-parses
// (`Invoke-Expression` on Windows, the shell body on POSIX). It was always
// POSIX-quoted, so on Windows an apostrophe in the dev3 system prompt — "the
// task's title" — arrived as `'\''`, where `\` ends the PowerShell literal and
// the rest of the prompt is parsed as code. Every Claude launch on Windows died
// with a ParserError before the binary was looked up (Seq 1737).
//
// What the argument then does inside the callee is proved by executing it:
// `agent-launch-args.bun-e2e.ts` runs the real wrapper on the real platform.
// This file pins the spelling on both dialects from one machine, and covers the
// CALL SITE — `resolveAgentCommand`, which an E2E calling the helper cannot.
// ---------------------------------------------------------------------------

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function asPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
});

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

describe("powerShellNativeArg", () => {
	it("doubles the apostrophe instead of writing the POSIX escape", () => {
		expect(powerShellNativeArg("the task's title")).toBe("'the task''s title'");
		expect(powerShellNativeArg("the task's title")).not.toContain("\\'");
	});

	it("escapes a double quote for the callee's C runtime", () => {
		expect(powerShellNativeArg('he said "no"')).toBe("'he said \\\"no\\\"'");
	});

	it("doubles the backslashes that a quote would otherwise halve", () => {
		expect(powerShellNativeArg('a\\"b')).toBe("'a\\\\\\\"b'");
	});

	it("doubles a trailing backslash run only when PowerShell will add a closing quote", () => {
		// Whitespace inside → PowerShell wraps the value, so the last backslash
		// would escape that closing quote and swallow it.
		expect(powerShellNativeArg("ends with \\")).toBe("'ends with \\\\'");
		// No whitespace → PowerShell appends no quote, so doubling would corrupt it.
		expect(powerShellNativeArg("ends-with\\")).toBe("'ends-with\\'");
	});

	it("leaves PowerShell's own metacharacters alone — a single-quoted literal is literal", () => {
		expect(powerShellNativeArg("$env:PATH `n $(x)")).toBe("'$env:PATH `n $(x)'");
	});

	it("passes an empty argument", () => {
		expect(powerShellNativeArg("")).toBe("''");
	});
});

describe("shellEscape follows the platform dialect", () => {
	it("POSIX keeps the historical escape byte-for-byte", () => {
		asPlatform("darwin");
		expect(shellEscape("the task's title")).toBe("'the task'\\''s title'");
	});

	it("Windows never emits the POSIX escape", () => {
		asPlatform("win32");
		expect(shellEscape("the task's title")).toBe("'the task''s title'");
	});
});

describe("commandToken", () => {
	it("leaves a bare command name alone on both dialects", () => {
		asPlatform("darwin");
		expect(commandToken("claude")).toBe("claude");
		expect(commandToken("/usr/local/bin/claude")).toBe("/usr/local/bin/claude");
		asPlatform("win32");
		expect(commandToken("claude")).toBe("claude");
	});

	it("leaves a multi-word baseCommand as shell text — it is the user's own", () => {
		asPlatform("darwin");
		expect(commandToken("npx claude")).toBe("npx claude");
		asPlatform("win32");
		expect(commandToken("npx claude")).toBe("npx claude");
	});

	it("quotes an absolute path that needs it", () => {
		asPlatform("darwin");
		expect(commandToken("/Users/john smith/bin/claude")).toBe("'/Users/john smith/bin/claude'");
	});

	it("Windows calls a quoted path instead of printing it back", () => {
		asPlatform("win32");
		expect(commandToken("C:\\Users\\John Smith\\.local\\bin\\claude.exe")).toBe(
			"& 'C:\\Users\\John Smith\\.local\\bin\\claude.exe'",
		);
		// A backslash is an escape in this dialect, so even a space-free path is quoted.
		expect(commandToken("C:\\Users\\user\\.local\\bin\\claude.exe")).toBe(
			"& 'C:\\Users\\user\\.local\\bin\\claude.exe'",
		);
	});
});

describe("the launch call site", () => {
	it("resolveAgentCommand emits no POSIX escape on Windows", () => {
		// Not a synthetic string: this is the prompt every Claude launch carries,
		// and the apostrophes in it are what killed the .ps1 parse. On Windows it
		// now travels as a file (the ceiling below), so what must be gone from the
		// command line is the POSIX escape — in the prompt and everywhere else.
		expect(DEV3_SYSTEM_PROMPT).toContain("'");
		asPlatform("win32");
		const cmd = resolveAgentCommand(agent("claude"), undefined, CTX);
		expect(cmd).toContain("--append-system-prompt-file");
		expect(cmd).not.toContain("'\\''");
		expect(cmd).toContain(powerShellNativeArg("Fix the login bug"));
	});

	it("resolveAgentCommand still emits the POSIX escape on POSIX", () => {
		asPlatform("darwin");
		const cmd = resolveAgentCommand(agent("claude"), undefined, CTX);
		expect(cmd).toContain("'\\''");
	});

	it("resolveAgentCommand spells a resolved binary path as a command", () => {
		asPlatform("win32");
		const cmd = resolveAgentCommand(agent("C:\\Users\\John Smith\\bin\\claude.exe"), undefined, CTX);
		expect(cmd.startsWith("& 'C:\\Users\\John Smith\\bin\\claude.exe' ")).toBe(true);
	});

	it("buildResumeCommand spells it the same way", () => {
		asPlatform("win32");
		expect(buildResumeCommand("C:\\Users\\John Smith\\bin\\claude.exe", "sid", "claude")).toBe(
			"& 'C:\\Users\\John Smith\\bin\\claude.exe' --resume sid",
		);
		asPlatform("darwin");
		expect(buildResumeCommand("claude", "sid", "claude")).toBe("claude --resume sid");
	});
});

describe("the command-line ceiling", () => {
	it("the dev3 protocol does not fit in a Windows command line at any quoting", () => {
		// Found by the first Windows run of the E2E: CreateProcess refuses past
		// 32 767 characters, and the body alone is longer than that.
		expect(CLAUDE_SKILL_BODY.length).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
	});

	it("only Windows needs the file", () => {
		expect(systemPromptNeedsFile("win32")).toBe(true);
		expect(systemPromptNeedsFile("darwin")).toBe(false);
		expect(systemPromptNeedsFile("linux")).toBe(false);
	});

	it("Claude takes a path, and the command line then fits with room to spare", () => {
		const cmd = claudeAdapter
			.launchArgs("claude", undefined, CTX, { systemPromptFile: "C:\\dev3\\claude.md" })
			.join(" ");
		expect(cmd).toContain("--append-system-prompt-file 'C:\\dev3\\claude.md'");
		expect(cmd).not.toContain("--append-system-prompt ");
		expect(cmd.length).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
	});

	it("without a file the body is still inline — POSIX is unchanged", () => {
		const cmd = claudeAdapter.launchArgs("claude", undefined, CTX, {}).join(" ");
		expect(cmd).toContain("--append-system-prompt ");
		expect(cmd).not.toContain("--append-system-prompt-file");
	});

	it("skipSystemPrompt still means no protocol at all", () => {
		const cmd = claudeAdapter
			.launchArgs("claude", undefined, CTX, { skipSystemPrompt: true, systemPromptFile: "C:\\dev3\\claude.md" })
			.join(" ");
		expect(cmd).not.toContain("--append-system-prompt");
	});
});

describe("the dialect exposes both quoting jobs", () => {
	it("POSIX hands a word straight to execve, so one spelling covers both", () => {
		const d = launchDialect("darwin");
		expect(d.nativeArg("a'b")).toBe(d.quote("a'b"));
	});

	it("Windows needs two, because two parsers run in series", () => {
		const d = launchDialect("win32");
		expect(d.quote('a"b')).toBe("'a\"b'");
		expect(d.nativeArg('a"b')).toBe("'a\\\"b'");
	});
});
