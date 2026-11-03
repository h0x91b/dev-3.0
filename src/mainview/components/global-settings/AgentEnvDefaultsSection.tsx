import { useCallback, useRef } from "react";
import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { EnvVarsEditor } from "../project-settings/EnvVarsEditor";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

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
	const handleErrorChange = useCallback((error: boolean) => {
		hasError.current = error;
	}, []);
	function commit() {
		if (!draft.current || hasError.current) return;
		const next = Object.keys(draft.current).length > 0 ? draft.current : undefined;
		draft.current = undefined;
		if (JSON.stringify(next) !== JSON.stringify(globalSettings.agentEnvDefaults)) onChange(next);
	}

	return (
		<SettingsSection title={t("settings.agentEnvDefaults")}>
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
