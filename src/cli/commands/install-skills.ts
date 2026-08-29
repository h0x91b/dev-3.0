import { installAgentSkills, MANAGED_SKILL_FILES } from "../../bun/agent-skills";
import { setMinLevel } from "../../bun/logger";
import { LOW_BATTERY_REVISION, lowBatterySkillFiles } from "../../bun/low-battery";
import { loadSettingsSync } from "../../bun/settings";

export async function handleInstallSkills(): Promise<void> {
	setMinLevel("error");
	// Re-installing must not resurrect a feature the user switched off in Settings.
	const lowBattery = loadSettingsSync().lowBatteryDisabled !== true;
	installAgentSkills({ lowBattery });

	process.stdout.write("Installed agent skills:\n");
	for (const rel of MANAGED_SKILL_FILES) {
		process.stdout.write(`  ~/${rel}\n`);
	}
	if (lowBattery) {
		for (const rel of lowBatterySkillFiles()) {
			process.stdout.write(`  ~/${rel}\n`);
		}
		process.stdout.write(`  ~/.claude/output-styles/low-battery.md (upstream ${LOW_BATTERY_REVISION.slice(0, 8)})\n`);
	}
	process.stdout.write(`  ~/.agents/skills/*/agents/openai.yaml (managed skill metadata)\n`);
	process.stdout.write(`  ~/.agents/AGENTS.md (dev3 block)\n`);
	process.stdout.write(`  ~/.claude/settings.json (Bash permission)\n`);
	process.stdout.write(`  ~/.codex/config.toml (trust + socket access + Codex hook feature)\n`);
}
