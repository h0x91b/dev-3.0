import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setCodexProfileV2Override, resolveAgentCommand, type TemplateContext } from "../agents";
import { AGENT_PROMPTS_DIR } from "../agent-system-prompt-file";
import { leanSkillBodyFor, skillBodyFor, type SkillFamily } from "../../shared/agent-skill-content";
import { taskProtocolMode, type CodingAgent, type ProtocolMode } from "../../shared/types";

// A task in a project with its git workflow off runs in a folder other tasks
// share. Its agent must not be told to rename a task branch, to treat the folder
// as its private worktree, or that a PR through `dev3 pr create` is mandatory.

const FAMILIES: SkillFamily[] = ["claude", "codex", "omp", "pi", "generic"];

/** Instructions only true for a task that owns a worktree and a `dev3/task-*` branch. */
const WORKTREE_ONLY = [
	"This worktree already IS your isolation.",
	"git branch -m",
	"dev3/task-",
	"## Branch naming",
	"rename the branch",
	"never `gh` by hand",
	"disposable worktree",
	"this worktree and terminal session are destroyed",
];

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const realLean = process.env.DEV3_LEAN_PROTOCOL;

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	if (realLean === undefined) delete process.env.DEV3_LEAN_PROTOCOL;
	else process.env.DEV3_LEAN_PROTOCOL = realLean;
	__setCodexProfileV2Override(null);
});

describe("taskProtocolMode", () => {
	it.each([
		["git workflow on", { gitWorkflow: undefined }, {}, "worktree"],
		["git workflow off", { gitWorkflow: false }, {}, "shared-folder"],
		["git workflow off, own worktree", { gitWorkflow: false }, { ownWorktree: true }, "worktree"],
		["virtual board", { kind: "virtual" as const }, {}, "worktree"],
	])("%s → %s", (_name, project, task, expected) => {
		expect(taskProtocolMode(project, task)).toBe(expected);
	});
});

describe("protocol variants", () => {
	for (const family of FAMILIES) {
		const variants: Array<[string, (mode: ProtocolMode) => string]> = [
			["full", (mode) => skillBodyFor(family, mode)],
			["lean", (mode) => leanSkillBodyFor(family, mode)],
		];
		for (const [kind, body] of variants) {
			it(`${family} ${kind}: shared-folder drops every worktree-only instruction`, () => {
				const shared = body("shared-folder");
				expect(WORKTREE_ONLY.filter((line) => shared.includes(line))).toEqual([]);
				expect(shared).toContain("**Other tasks edit this tree at the same time.**");
				expect(shared).toContain("**PRs are optional here.**");
				expect(shared).toContain("**Preservation gate (mandatory):**");
			});

			it(`${family} ${kind}: worktree keeps them`, () => {
				const worktree = body("worktree");
				for (const line of WORKTREE_ONLY) expect(worktree, line).toContain(line);
			});
		}

		it(`${family}: the shared-folder lean body is taken verbatim from its full body`, () => {
			const fullLines = new Set(skillBodyFor(family, "shared-folder").split("\n"));
			const invented = leanSkillBodyFor(family, "shared-folder").split("\n").filter((line) => !fullLines.has(line));
			expect(invented).toEqual([]);
		});
	}
});

// Pinned to macOS: the worktree PR section is worded per platform, and CI is not macOS.
// A deliberate protocol edit updates these with `vitest -u`; the lean body is
// covered above as a verbatim subset of the full one.
describe("rendered variant snapshots", () => {
	for (const mode of ["worktree", "shared-folder"] as const) {
		it(`claude ${mode}`, async () => {
			Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
			vi.resetModules();
			const mod = await import("../../shared/agent-skill-content");
			expect(mod.skillBodyFor("claude", mode)).toMatchSnapshot();
		});
	}
});

const CTX: TemplateContext = {
	taskTitle: "Draft the summary",
	taskDescription: "Draft the summary",
	projectName: "notes",
	projectPath: "/path/to/notes",
	worktreePath: "/path/to/notes",
};

const agent = (baseCommand: string): CodingAgent => ({ id: "a", name: "A", baseCommand, configurations: [], defaultConfigId: "d" });

function onPosix(): void {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	__setCodexProfileV2Override(false);
}

function promptFileOf(cmd: string): string {
	const file = cmd.match(/--append-system-prompt-file (?:'([^']+)'|(\S+))/)?.slice(1).find(Boolean);
	if (!file) throw new Error(`no prompt file in: ${cmd.slice(0, 300)}`);
	return file;
}

describe("launching a shared-folder task", () => {
	it("Claude reads the shared-folder body from its own file", async () => {
		onPosix();
		delete process.env.DEV3_LEAN_PROTOCOL;
		const cmd = await resolveAgentCommand(agent("claude"), undefined, CTX, { protocolMode: "shared-folder" });
		const file = promptFileOf(cmd);
		expect(file).toBe(join(AGENT_PROMPTS_DIR, "claude-shared-folder.md"));
		expect(readFileSync(file, "utf-8")).toBe(skillBodyFor("claude", "shared-folder"));
	});

	it("a launch without a mode keeps the worktree body and file", async () => {
		onPosix();
		delete process.env.DEV3_LEAN_PROTOCOL;
		const file = promptFileOf(await resolveAgentCommand(agent("claude"), undefined, CTX));
		expect(file).toBe(join(AGENT_PROMPTS_DIR, "claude.md"));
		expect(readFileSync(file, "utf-8")).toBe(skillBodyFor("claude", "worktree"));
	});

	it("the lean shared-folder body names the shared-folder full body", async () => {
		onPosix();
		process.env.DEV3_LEAN_PROTOCOL = "1";
		const file = promptFileOf(await resolveAgentCommand(agent("claude"), undefined, CTX, { protocolMode: "shared-folder" }));
		expect(file).toBe(join(AGENT_PROMPTS_DIR, "claude-shared-folder-lean.md"));
		const lean = readFileSync(file, "utf-8");
		expect(lean.startsWith(leanSkillBodyFor("claude", "shared-folder"))).toBe(true);
		expect(lean).toContain(`\`${join(AGENT_PROMPTS_DIR, "claude-shared-folder.md")}\``);
	});

	it("Codex carries the shared-folder body inline", async () => {
		onPosix();
		delete process.env.DEV3_LEAN_PROTOCOL;
		const cmd = await resolveAgentCommand(agent("codex"), undefined, CTX, { protocolMode: "shared-folder" });
		expect(cmd).toContain("**PRs are optional here.**");
		expect(cmd).not.toContain("This worktree already IS your isolation.");
	});

	it.each(["gemini", "copilot"])("%s, which injects no protocol, gets the folder rules in its prompt", async (command) => {
		onPosix();
		const cmd = await resolveAgentCommand(agent(command), undefined, CTX, { protocolMode: "shared-folder" });
		expect(cmd).toContain("dev3: this task shares its folder");
		expect(cmd).toContain("never switch, rebase, pull or amend");
		expect(await resolveAgentCommand(agent(command), undefined, CTX)).not.toContain("dev3: this task shares its folder");
	});

	it("an agent that injects the protocol gets no duplicate notice in its prompt", async () => {
		onPosix();
		delete process.env.DEV3_LEAN_PROTOCOL;
		const cmd = await resolveAgentCommand(agent("codex"), undefined, CTX, { protocolMode: "shared-folder" });
		expect(cmd).not.toContain("dev3: this task shares its folder");
	});
});

describe("shared-folder safety rules", () => {
	it.each(FAMILIES)("%s: forbids moving the folder's shared branch", (family) => {
		const body = skillBodyFor(family, "shared-folder");
		for (const cmd of ["git switch", "git checkout <branch>", "git rebase", "git pull", "git commit --amend"]) expect(body).toContain(cmd);
		expect(body).toContain("never a branch you create or switch to here");
	});
});
