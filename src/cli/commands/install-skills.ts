import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { installAgentSkills, MANAGED_SKILL_FILES } from "../../bun/agent-skills";
import { claudeConfigLocation } from "../../shared/claude-config-dir";
import { setMinLevel } from "../../bun/logger";
import { LOW_BATTERY_REVISION, lowBatterySkillFiles } from "../../bun/low-battery";
import { loadSettingsSync } from "../../bun/settings";

export async function handleInstallSkills(): Promise<void> {
	setMinLevel("error");
	// Re-installing must not turn on a feature the user never asked for, nor
	// resurrect one they switched off in Settings.
	const lowBattery = loadSettingsSync().lowBatteryEnabled;
	await installAgentSkills({ lowBattery });

	// Claude's files land in CLAUDE_CONFIG_DIR when it is set, so print where they really went.
	const claude = claudeConfigLocation(process.env, homedir());
	const pinned = claude.pinned && isAbsolute(claude.dir);
	const display = (rel: string) => (pinned && rel.startsWith(".claude/") ? `${claude.dir}/${rel.slice(".claude/".length)}` : `~/${rel}`);

	process.stdout.write("Installed agent skills:\n");
	for (const rel of MANAGED_SKILL_FILES) {
		process.stdout.write(`  ${display(rel)}\n`);
	}
	if (lowBattery === true) {
		for (const rel of lowBatterySkillFiles()) {
			process.stdout.write(`  ~/${rel}\n`);
		}
		process.stdout.write(`  ~/.claude/output-styles/low-battery.md (upstream ${LOW_BATTERY_REVISION.slice(0, 8)})\n`);
	}
	process.stdout.write(`  ~/.agents/skills/*/agents/openai.yaml (managed skill metadata)\n`);
	process.stdout.write(`  ~/.agents/AGENTS.md (dev3 block)\n`);
	process.stdout.write(`  ${display(".claude/settings.json")} (Bash permission)\n`);
	process.stdout.write(`  ~/.codex/config.toml (trust + socket access + Codex hook feature)\n`);
}
