import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the side-effecting installer is faked; MANAGED_SKILL_FILES stays real so
// the printed list is asserted against what the installer actually writes.
vi.mock("../../bun/agent-skills", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../bun/agent-skills")>()),
	installAgentSkills: vi.fn(),
}));

import { installAgentSkills } from "../../bun/agent-skills";
import { handleInstallSkills } from "../commands/install-skills";

const mockInstall = vi.mocked(installAgentSkills);

let stdoutOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

describe("install-skills", () => {
	beforeEach(() => {
		stdoutOutput = "";
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutOutput += String(chunk);
			return true;
		});
		mockInstall.mockReset();
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it("prints Claude's files under CLAUDE_CONFIG_DIR when it is set", async () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/pinned/cfg");
		await handleInstallSkills();

		expect(stdoutOutput).toContain("  /pinned/cfg/skills/dev3/SKILL.md\n");
		expect(stdoutOutput).toContain("  /pinned/cfg/settings.json (Bash permission)\n");
		expect(stdoutOutput).not.toContain("~/.claude/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain("~/.codex/skills/dev3/SKILL.md");
	});

	it("calls installAgentSkills and prints installed paths", async () => {
		await handleInstallSkills();

		expect(mockInstall).toHaveBeenCalledOnce();
		expect(stdoutOutput).toContain("Installed agent skills:");
		expect(stdoutOutput).toContain(".claude/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".claude/skills/dev3-bug-hunter/SKILL.md");
		expect(stdoutOutput).toContain(".cursor/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".cursor/skills/dev3-project-config/SKILL.md");
		expect(stdoutOutput).toContain(".agents/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".agents/skills/dev3-bug-hunter/SKILL.md");
		expect(stdoutOutput).toContain(".codex/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".codex/skills/dev3-project-config/SKILL.md");
		expect(stdoutOutput).toContain(".opencode/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".config/opencode/skills/dev3-bug-hunter/SKILL.md");
		expect(stdoutOutput).toContain(".claude/skills/ask-dev3/SKILL.md");
		expect(stdoutOutput).toContain(".claude/skills/dev3-tmux/SKILL.md");
		expect(stdoutOutput).toContain(".claude/skills/dev3-share-artifact/SKILL.md");
		expect(stdoutOutput).not.toContain(".gemini/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain("~/.agents/skills/*/agents/openai.yaml");
		expect(stdoutOutput).toContain("AGENTS.md");
		expect(stdoutOutput).toContain("settings.json");
		expect(stdoutOutput).toContain("config.toml");
	});

	it("propagates errors from installAgentSkills", async () => {
		mockInstall.mockImplementation(() => {
			throw new Error("permission denied");
		});

		await expect(handleInstallSkills()).rejects.toThrow("permission denied");
	});
});
