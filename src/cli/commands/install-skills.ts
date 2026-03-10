import { installAgentSkills } from "../../bun/agent-skills";

const SKILL_PATHS = [
	".claude/skills/dev3/SKILL.md",
	".cursor/skills/dev3/SKILL.md",
	".agents/skills/dev3/SKILL.md",
	".codex/skills/dev3/SKILL.md",
	".gemini/skills/dev3/SKILL.md",
	".opencode/skills/dev3/SKILL.md",
];

export async function handleInstallSkills(): Promise<void> {
	installAgentSkills();

	process.stdout.write("Installed agent skills:\n");
	for (const rel of SKILL_PATHS) {
		process.stdout.write(`  ~/${rel}\n`);
	}
	process.stdout.write(`  ~/.agents/AGENTS.md (dev3 block)\n`);
	process.stdout.write(`  ~/.claude/settings.json (Bash permission)\n`);
	process.stdout.write(`  ~/.codex/config.toml (trust + socket access)\n`);
}
