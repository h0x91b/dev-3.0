import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../bun/agent-skills", () => ({
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
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	it("calls installAgentSkills and prints installed paths", async () => {
		await handleInstallSkills();

		expect(mockInstall).toHaveBeenCalledOnce();
		expect(stdoutOutput).toContain("Installed agent skills:");
		expect(stdoutOutput).toContain(".claude/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".cursor/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".agents/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".codex/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".gemini/skills/dev3/SKILL.md");
		expect(stdoutOutput).toContain(".opencode/skills/dev3/SKILL.md");
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
