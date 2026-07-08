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
		expect(existsSync(join(tempHome, ".gemini/skills/dev3"))).toBe(false);
		expect(existsSync(join(tempHome, ".gemini/skills/dev3-project-config"))).toBe(false);
		expect(existsSync(join(tempHome, ".gemini/skills/dev3-tmux"))).toBe(false);
		expect(ensureCodexConfigFile).toHaveBeenCalledWith(tempHome);
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
});
