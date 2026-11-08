import { useCallback, useRef } from "react";
import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { usesProjectClaudeConfigDir, withProjectClaudeConfigDir } from "../../../shared/agent-env-defaults";
import { EnvVarsEditor } from "../project-settings/EnvVarsEditor";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function AgentEnvDefaultsSection({
	t,
	globalSettings,
	onChange,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onChange: (env: Record<string, string> | undefined) => void;
}) {
	// Saved on blur, like the other free-text settings: one write per edit, not per keystroke.
	// The draft is the last VALID parse, so text with an invalid line is never saved.
	const draft = useRef<Record<string, string> | undefined>(undefined);
	const hasError = useRef(false);
	// The last value sent up: a switch click right after a text edit must build on it,
	// not on props that have not caught up with that save yet.
	const saved = useRef(globalSettings.agentEnvDefaults);
	saved.current = globalSettings.agentEnvDefaults;
	const handleErrorChange = useCallback((error: boolean) => {
		hasError.current = error;
	}, []);
	function commit() {
		if (!draft.current || hasError.current) return;
		const next = Object.keys(draft.current).length > 0 ? draft.current : undefined;
		draft.current = undefined;
		if (JSON.stringify(next) === JSON.stringify(saved.current)) return;
		saved.current = next;
		onChange(next);
	}
	const projectFolder = usesProjectClaudeConfigDir(globalSettings.agentEnvDefaults);
	function toggleProjectFolder() {
		const next = withProjectClaudeConfigDir(saved.current, !projectFolder);
		saved.current = next;
		onChange(next);
	}

	return (
		<SettingsSection title={t("settings.agentEnvDefaults")}>
			<SettingsEntry anchor="project-claude-folder">
				<div>
					<p className="text-fg-3 text-sm mb-3">{t("settings.projectClaudeFolderDesc")}</p>
					<SettingsToggle
						checked={projectFolder}
						ariaLabel={t("settings.projectClaudeFolder")}
						onLabel={t("settings.projectClaudeFolder")}
						offLabel={t("settings.projectClaudeFolder")}
						onToggle={toggleProjectFolder}
					/>
				</div>
			</SettingsEntry>
			<SettingsEntry anchor="agent-env-defaults">
				<div onBlur={commit}>
					<EnvVarsEditor
						env={globalSettings.agentEnvDefaults}
						storageScope="defaults"
						onErrorChange={handleErrorChange}
						onChange={(env) => {
							draft.current = env;
						}}
					/>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
