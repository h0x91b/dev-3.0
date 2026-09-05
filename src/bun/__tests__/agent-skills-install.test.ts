import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("installAgentSkills", () => {
	let tempHome = "";

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "dev3-agent-skills-"));
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempHome, { recursive: true, force: true });
	});

	async function loadModule() {
		const ensureCodexConfigFile = vi.fn();

		vi.doMock("node:os", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:os")>();
			return { ...actual, homedir: () => tempHome };
		});
		vi.doMock("../logger", () => ({
			createLogger: () => ({
				info: vi.fn(),
				warn: vi.fn(),
			}),
		}));
		vi.doMock("../codex-config", () => ({
			ensureCodexConfigFile,
		}));

		const mod = await import("../agent-skills");
		return { installAgentSkills: mod.installAgentSkills, ensureCodexConfigFile };
	}

	it("removes legacy Gemini-specific copies when shared .agents skills are installed", async () => {
		mkdirSync(join(tempHome, ".gemini/skills/dev3"), { recursive: true });
		writeFileSync(join(tempHome, ".gemini/skills/dev3/SKILL.md"), "legacy dev3", "utf-8");
		mkdirSync(join(tempHome, ".gemini/skills/dev3-project-config"), { recursive: true });
		writeFileSync(
			join(tempHome, ".gemini/skills/dev3-project-config/SKILL.md"),
			"legacy project config",
			"utf-8",
		);
		mkdirSync(join(tempHome, ".gemini/skills/dev3-tmux"), { recursive: true });
		writeFileSync(
			join(tempHome, ".gemini/skills/dev3-tmux/SKILL.md"),
			"legacy tmux",
			"utf-8",
		);

		const { installAgentSkills, ensureCodexConfigFile } = await loadModule();
		installAgentSkills();

		expect(existsSync(join(tempHome, ".agents/skills/dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-project-config/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-tmux/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/skills/dev3-tmux/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".codex/skills/dev3-tmux/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-bug-hunter/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/skills/dev3-bug-hunter/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".codex/skills/dev3-bug-hunter/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3/agents/openai.yaml"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-project-config/agents/openai.yaml"))).toBe(
			true,
		);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-tmux/agents/openai.yaml"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/dev3-bug-hunter/agents/openai.yaml"))).toBe(
			true,
		);
		expect(existsSync(join(tempHome, ".agents/skills/ask-dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/skills/ask-dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".codex/skills/ask-dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".agents/skills/ask-dev3/agents/openai.yaml"))).toBe(true);
		expect(existsSync(join(tempHome, ".gemini/skills/dev3"))).toBe(false);
		expect(existsSync(join(tempHome, ".gemini/skills/dev3-project-config"))).toBe(false);
		expect(existsSync(join(tempHome, ".gemini/skills/dev3-tmux"))).toBe(false);
		expect(ensureCodexConfigFile).toHaveBeenCalledWith(tempHome);
	});

	it("can defer Codex config patching until the shell PATH is resolved", async () => {
		const { installAgentSkills, ensureCodexConfigFile } = await loadModule();
		installAgentSkills({ configureCodex: false });

		expect(ensureCodexConfigFile).not.toHaveBeenCalled();
	});

	it("writes the full-protocol PROTOCOL.md fallback next to the short Claude SKILL.md", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills();

		expect(existsSync(join(tempHome, ".claude/skills/dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/skills/dev3/PROTOCOL.md"))).toBe(true);
	});

	it("keeps shared AGENTS.md neutral about hook-owned versus manual lifecycle", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills();

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("Follow the agent-specific status section in the loaded dev3 skill");
		expect(agentsMd).not.toContain("task move --status in-progress");
		expect(agentsMd).not.toContain("At the END of every turn, move the task");
	});

	/**
	 * A skill is inert until something loads it, so every non-Claude harness needs
	 * an always-on line. It has to live inside dev3's existing managed block: the
	 * user's own notes in that file are never dev3's to disturb.
	 */
	it("puts the low-battery always-on line inside the managed block, and nowhere else", async () => {
		mkdirSync(join(tempHome, ".agents"), { recursive: true });
		writeFileSync(join(tempHome, ".agents/AGENTS.md"), "# My own notes\n\nKeep these.\n", "utf-8");

		const { installAgentSkills } = await loadModule();
		installAgentSkills({ lowBattery: true });

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("# My own notes");
		expect(agentsMd).toContain("Keep these.");
		const block = /<!-- dev3:start -->[\s\S]*<!-- dev3:end -->/.exec(agentsMd)?.[0] ?? "";
		expect(block).toContain("low-battery");
		// Outside the block, dev3 wrote nothing.
		expect(agentsMd.replace(block, "")).not.toContain("low-battery");
	});

	it("stays a single managed block across repeated installs", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills({ lowBattery: true });
		installAgentSkills({ lowBattery: true });
		installAgentSkills({ lowBattery: true });

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd.match(/<!-- dev3:start -->/g)).toHaveLength(1);
		expect(agentsMd.match(/<!-- dev3:end -->/g)).toHaveLength(1);
		expect(agentsMd.match(/Load the `low-battery` skill/g)).toHaveLength(1);
	});

	it("takes the always-on line back out when low-battery is switched off", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills({ lowBattery: true });
		expect(readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8")).toContain("low-battery");

		installAgentSkills({ lowBattery: false });

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).not.toContain("low-battery");
		expect(agentsMd.match(/<!-- dev3:start -->/g)).toHaveLength(1);
		// The dev3 protocol itself is untouched by the low-battery toggle.
		expect(agentsMd).toContain("dev-3.0 Managed Worktree");
		expect(existsSync(join(tempHome, ".agents/skills/low-battery"))).toBe(false);
	});

	it("installs low-battery on an explicit opt-in and removes it on an explicit opt-out", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills({ lowBattery: true });
		expect(existsSync(join(tempHome, ".agents/skills/low-battery/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/output-styles/low-battery.md"))).toBe(true);

		installAgentSkills({ lowBattery: false });
		expect(existsSync(join(tempHome, ".agents/skills/low-battery/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempHome, ".claude/output-styles/low-battery.md"))).toBe(false);
		// dev3's own skills are untouched by the low-battery toggle.
		expect(existsSync(join(tempHome, ".agents/skills/dev3/SKILL.md"))).toBe(true);
	});
	/**
	 * The ruling that made low-battery opt-in: an install nobody configured must not
	 * ship the rules, select an output style, or put the always-on line in AGENTS.md.
	 */
	it("installs nothing when no choice is stored", async () => {
		const { installAgentSkills } = await loadModule();
		installAgentSkills();

		expect(existsSync(join(tempHome, ".agents/skills/low-battery"))).toBe(false);
		expect(existsSync(join(tempHome, ".claude/output-styles/low-battery.md"))).toBe(false);
		expect(readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8")).not.toContain("low-battery");
		// dev3's own skills still install — only low-battery waits to be asked for.
		expect(existsSync(join(tempHome, ".agents/skills/dev3/SKILL.md"))).toBe(true);
	});

	/**
	 * "No choice stored" is not "switched off": a `low-battery` skill dir may be the
	 * user's own copy from upstream, so dev3 leaves the disk alone until asked.
	 */
	it("deletes nothing on disk when no choice is stored", async () => {
		const { installAgentSkills } = await loadModule();
		const ownSkill = join(tempHome, ".claude/skills/low-battery");
		mkdirSync(ownSkill, { recursive: true });
		writeFileSync(join(ownSkill, "SKILL.md"), "my own copy", "utf-8");

		installAgentSkills();

		expect(readFileSync(join(ownSkill, "SKILL.md"), "utf-8")).toBe("my own copy");
	});
});
