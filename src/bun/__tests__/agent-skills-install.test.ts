import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("installAgentSkills", () => {
	let tempHome = "";

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "dev3-agent-skills-"));
		vi.resetModules();
		vi.stubEnv("DEV3_COMPACT_AGENT_SKILLS", undefined);
		// The developer running the suite may pin their own config dir; never write into it.
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.doUnmock("node:fs");
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
		return { ...mod, ensureCodexConfigFile };
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
		await installAgentSkills();

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
		// omp's own dir carries the hook-aware body, not the manual-status generic one.
		const ompSkill = readFileSync(join(tempHome, ".omp/agent/skills/dev3/SKILL.md"), "utf-8");
		expect(ompSkill).toContain("dev3 injects trusted native hooks into every omp pane");
		expect(ompSkill).toContain("the dev3 status extension loaded into this session already owns that transition");
		expect(ompSkill).not.toContain("Start of every turn");
		expect(existsSync(join(tempHome, ".gemini/skills/dev3-tmux"))).toBe(false);
		expect(ensureCodexConfigFile).toHaveBeenCalledWith(tempHome);
	});

	it("installs compact references with complete family-specific fallbacks only when opted in", async () => {
		vi.stubEnv("DEV3_COMPACT_AGENT_SKILLS", "1");
		const mod = await loadModule();
		await mod.installAgentSkills();

		for (const [dir, fallback] of [
			[".codex/skills/dev3", mod.getCodexSkillContent()],
			[".omp/agent/skills/dev3", mod.getOmpSkillContent()],
			[".agents/skills/dev3", mod.getGenericSkillContent()],
			[".cursor/skills/dev3", mod.getGenericSkillContent()],
			[".opencode/skills/dev3", mod.getGenericSkillContent()],
			[".config/opencode/skills/dev3", mod.getGenericSkillContent()],
		]) {
			const skill = readFileSync(join(tempHome, dir, "SKILL.md"), "utf-8");
			expect(skill).toContain("read PROTOCOL.md in this skill's directory");
			expect(skill).not.toContain("## Session-start checklist");
			expect(readFileSync(join(tempHome, dir, "PROTOCOL.md"), "utf-8")).toBe(fallback);
		}
		expect(readFileSync(join(tempHome, ".claude/skills/dev3/SKILL.md"), "utf-8")).toBe(mod.getClaudeSkillContent());
		const agents = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agents).toContain("already injected by your launch");
		expect(agents).toContain("If it is absent, load");
	});

	it("writes each complete fallback before exposing its compact skill", async () => {
		vi.stubEnv("DEV3_COMPACT_AGENT_SKILLS", "1");
		const writes: string[] = [];
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				writeFileSync: (path: string, data: string, encoding: "utf-8") => {
					writes.push(String(path));
					return actual.writeFileSync(path, data, encoding);
				},
			};
		});
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();
		for (const dir of [".codex/skills/dev3", ".omp/agent/skills/dev3", ".agents/skills/dev3", ".cursor/skills/dev3", ".opencode/skills/dev3", ".config/opencode/skills/dev3"]) {
			const fallback = writes.indexOf(join(tempHome, dir, "PROTOCOL.md"));
			const wrapper = writes.indexOf(join(tempHome, dir, "SKILL.md"));
			expect(fallback).toBeGreaterThanOrEqual(0);
			expect(wrapper).toBeGreaterThan(fallback);
		}
	});

	it.each([undefined, "0", "false", "true"])("restores original bytes after opting out with %s", async (flag) => {
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();
		const paths = [
			".codex/skills/dev3/SKILL.md", ".omp/agent/skills/dev3/SKILL.md",
			".agents/skills/dev3/SKILL.md", ".cursor/skills/dev3/SKILL.md",
			".opencode/skills/dev3/SKILL.md", ".config/opencode/skills/dev3/SKILL.md",
			".agents/AGENTS.md", ".claude/skills/dev3/SKILL.md",
		];
		const before = paths.map((path) => readFileSync(join(tempHome, path), "utf-8"));
		vi.stubEnv("DEV3_COMPACT_AGENT_SKILLS", "1");
		await installAgentSkills();
		vi.stubEnv("DEV3_COMPACT_AGENT_SKILLS", flag);
		await installAgentSkills();
		expect(paths.map((path) => readFileSync(join(tempHome, path), "utf-8"))).toEqual(before);
	});

	it("installs Claude skills and settings into CLAUDE_CONFIG_DIR as well as ~/.claude when it is set", async () => {
		const pinned = join(tempHome, "pinned-claude");
		vi.stubEnv("CLAUDE_CONFIG_DIR", pinned);
		const { installAgentSkills, MANAGED_SKILL_FILES } = await loadModule();
		await installAgentSkills();

		for (const rel of MANAGED_SKILL_FILES.filter((f) => f.startsWith(".claude/"))) {
			expect(existsSync(join(pinned, rel.slice(".claude/".length)))).toBe(true);
		}
		expect(existsSync(join(pinned, "skills/dev3/PROTOCOL.md"))).toBe(true);
		const settings = JSON.parse(readFileSync(join(pinned, "settings.json"), "utf-8"));
		expect(settings.permissions.allow.some((rule: string) => rule.includes("dev3"))).toBe(true);
		// ~/.claude stays current too: managed accounts symlink it, unpinned launches read it.
		expect(existsSync(join(tempHome, ".claude/skills/dev3/SKILL.md"))).toBe(true);
		// Other agents' dirs are unaffected by a Claude-only variable.
		expect(existsSync(join(tempHome, ".codex/skills/dev3/SKILL.md"))).toBe(true);
	});

	it("leaves a relative CLAUDE_CONFIG_DIR on the server env to launches, which know the worktree", async () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "relative-claude");
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();

		expect(existsSync(join(process.cwd(), "relative-claude"))).toBe(false);
		expect(existsSync(join(tempHome, ".claude/skills/dev3/SKILL.md"))).toBe(true);
	});

	it("leaves a settings.json that does not parse untouched", async () => {
		const dir = join(tempHome, "pinned-claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), "{ broken", "utf-8");
		const { installClaudeConfigDir } = await loadModule();
		installClaudeConfigDir(dir, tempHome);

		expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("{ broken");
		expect(existsSync(join(dir, "skills/dev3/SKILL.md"))).toBe(true);
	});

	it("can defer Codex config patching until the shell PATH is resolved", async () => {
		const { installAgentSkills, ensureCodexConfigFile } = await loadModule();
		await installAgentSkills({ configureCodex: false });

		expect(ensureCodexConfigFile).not.toHaveBeenCalled();
	});

	it("writes the full-protocol PROTOCOL.md fallback next to the short Claude SKILL.md", async () => {
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();

		expect(existsSync(join(tempHome, ".claude/skills/dev3/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".claude/skills/dev3/PROTOCOL.md"))).toBe(true);
	});

	it("keeps shared AGENTS.md neutral about hook-owned versus manual lifecycle", async () => {
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("Follow the agent-specific status section in the loaded dev3 skill");
		expect(agentsMd).not.toContain("task move --status in-progress");
		expect(agentsMd).not.toContain("At the END of every turn, move the task");
	});

	it("keeps the user's own notes outside the managed block", async () => {
		mkdirSync(join(tempHome, ".agents"), { recursive: true });
		writeFileSync(join(tempHome, ".agents/AGENTS.md"), "# My own notes\n\nKeep these.\n", "utf-8");

		const { installAgentSkills } = await loadModule();
		await installAgentSkills();

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("# My own notes");
		expect(agentsMd).toContain("Keep these.");
		expect(agentsMd).toContain("dev-3.0 Managed Worktree");
	});

	it("stays a single managed block across repeated installs", async () => {
		const { installAgentSkills } = await loadModule();
		await installAgentSkills();
		await installAgentSkills();
		await installAgentSkills();

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd.match(/<!-- dev3:start -->/g)).toHaveLength(1);
		expect(agentsMd.match(/<!-- dev3:end -->/g)).toHaveLength(1);
	});

	// Earlier builds put a low-battery always-on line inside the block; the rewrite drops it.
	it("drops the retired low-battery line an earlier build wrote into the block", async () => {
		mkdirSync(join(tempHome, ".agents"), { recursive: true });
		writeFileSync(
			join(tempHome, ".agents/AGENTS.md"),
			"<!-- dev3:start -->\n## Answer format\n\nLoad the `low-battery` skill.\n<!-- dev3:end -->\n",
			"utf-8",
		);

		const { installAgentSkills } = await loadModule();
		await installAgentSkills();

		const agentsMd = readFileSync(join(tempHome, ".agents/AGENTS.md"), "utf-8");
		expect(agentsMd).not.toContain("low-battery");
		expect(agentsMd).toContain("dev-3.0 Managed Worktree");
	});
});
