import { installAgentSkills, MANAGED_SKILL_FILES } from "../../bun/agent-skills";
import { setMinLevel } from "../../bun/logger";

export async function handleInstallSkills(): Promise<void> {
	setMinLevel("error");
	installAgentSkills();

	process.stdout.write("Installed agent skills:\n");
	for (const rel of MANAGED_SKILL_FILES) {
		process.stdout.write(`  ~/${rel}\n`);
	}
	process.stdout.write(`  ~/.agents/skills/*/agents/openai.yaml (managed skill metadata)\n`);
	process.stdout.write(`  ~/.agents/AGENTS.md (dev3 block)\n`);
	process.stdout.write(`  ~/.claude/settings.json (Bash permission)\n`);
	process.stdout.write(`  ~/.codex/config.toml (trust + socket access + Codex hook feature)\n`);
}
