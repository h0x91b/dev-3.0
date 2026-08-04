import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

/**
 * Home for beta behaviour that is useful but not yet stable enough to be on by
 * default. Every entry here ships off and states its own limitations.
 */
export default function AdvancedExperienceSection({
	t,
	globalSettings,
	onTerminalBidiToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onTerminalBidiToggle: (enabled: boolean) => void;
}) {
	const bidiEnabled = globalSettings.experimentalTerminalBidi === true;

	return (
		<SettingsSection
			title={t("settings.categoryAdvancedExperience")}
			description={t("settings.categoryAdvancedExperienceDesc")}
			helpTopicId="settings.advancedExperience"
		>
			<SettingsEntry anchor="experimental-terminal-bidi">
				<div>
					{/* Not a <label>: the control it heads is SettingsToggle, which carries
					    its own accessible name. A label with no association is never announced. */}
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.terminalBidi")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.terminalBidiDesc")}</p>
					<SettingsToggle
						checked={bidiEnabled}
						ariaLabel={t("settings.terminalBidi")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onTerminalBidiToggle(!bidiEnabled)}
					/>
					<p className="text-fg-muted text-xs mt-2">
						{t("settings.terminalBidiCaveat")}
					</p>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
