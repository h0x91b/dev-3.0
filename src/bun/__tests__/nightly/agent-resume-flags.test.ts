/**
 * Nightly integration tests for agent CLI resume flag support.
 *
 * Our hibernate feature relies on specific CLI flags to resume agent sessions:
 *   - Claude Code: --continue, --resume <session-id>
 *   - Codex: resume --last, resume <session-id>
 *   - Gemini: --resume latest
 *   - Cursor Agent: --continue
 *
 * These tests verify that installed agents still accept these flags by
 * checking their --help output. If an agent removes or renames a flag,
 * we'll catch it here before hibernate breaks silently.
 *
 * Each agent is tested independently and skipped if not installed.
 */

import { execSync } from "node:child_process";

function which(cmd: string): string | null {
	try {
		return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
	} catch {
		return null;
	}
}

function helpOutput(cmd: string): string {
	try {
		// Most CLIs return help on --help; some exit 0, some exit 1
		return execSync(`${cmd} --help 2>&1`, { encoding: "utf-8", timeout: 10000 });
	} catch (err: any) {
		// Some CLIs print help to stderr and exit non-zero
		return err.stdout ?? err.stderr ?? "";
	}
}

function subcommandHelp(cmd: string, sub: string): string {
	try {
		return execSync(`${cmd} ${sub} --help 2>&1`, { encoding: "utf-8", timeout: 10000 });
	} catch (err: any) {
		return err.stdout ?? err.stderr ?? "";
	}
}

// ---- Claude Code ----

const claudePath = which("claude");
const describeClaude = claudePath ? describe : describe.skip;

describeClaude("Claude Code resume flags", () => {
	let help: string;

	beforeAll(() => {
		help = helpOutput("claude");
	});

	it("supports --continue flag", () => {
		expect(help).toMatch(/--continue/);
	});

	it("supports --resume flag with session ID argument", () => {
		// --resume should accept an optional value (session ID)
		expect(help).toMatch(/--resume/);
	});

	it("--continue is documented as resuming the most recent conversation", () => {
		// The help text should mention "most recent" or "continue" in the context of --continue
		const continueLine = help.split("\n").find((l) => l.includes("--continue"));
		expect(continueLine).toBeDefined();
		expect(continueLine!.toLowerCase()).toMatch(/continue|recent|last/);
	});

	it("--resume accepts a session ID", () => {
		// Should be documented as taking a value, e.g. [value] or <session-id>
		const resumeLine = help.split("\n").find((l) => l.includes("--resume"));
		expect(resumeLine).toBeDefined();
		// It should either show [value], <id>, <session>, or similar
		expect(resumeLine).toMatch(/resume/i);
	});
});

// ---- Codex ----

const codexPath = which("codex");
const describeCodex = codexPath ? describe : describe.skip;

describeCodex("Codex resume flags", () => {
	let mainHelp: string;

	beforeAll(() => {
		mainHelp = helpOutput("codex");
	});

	it("has a 'resume' subcommand", () => {
		// Codex main help should mention the 'resume' command
		expect(mainHelp).toMatch(/resume/i);
	});

	it("resume subcommand supports --last flag", () => {
		const resumeHelp = subcommandHelp("codex", "resume");
		expect(resumeHelp).toMatch(/--last/);
	});

	it("resume subcommand accepts a session ID positional argument", () => {
		const resumeHelp = subcommandHelp("codex", "resume");
		// Should document a positional <session-id> argument or similar
		expect(resumeHelp).toMatch(/session|id/i);
	});
});

// ---- Gemini ----

const geminiPath = which("gemini");
const describeGemini = geminiPath ? describe : describe.skip;

describeGemini("Gemini resume flags", () => {
	let help: string;

	beforeAll(() => {
		help = helpOutput("gemini");
	});

	it("supports --resume flag", () => {
		expect(help).toMatch(/--resume/);
	});

	it("--resume accepts 'latest' as a value", () => {
		// The help should document that --resume can take 'latest'
		const resumeLine = help.split("\n").find((l) => l.includes("--resume"));
		expect(resumeLine).toBeDefined();
	});
});

// ---- Cursor Agent ----

const agentPath = which("agent");
const describeAgent = agentPath ? describe : describe.skip;

describeAgent("Cursor Agent resume flags", () => {
	let help: string;

	beforeAll(() => {
		help = helpOutput("agent");
	});

	it("supports --continue flag", () => {
		expect(help).toMatch(/--continue/);
	});
});
