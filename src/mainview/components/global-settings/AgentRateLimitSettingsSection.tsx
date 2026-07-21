import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function AgentRateLimitSettingsSection({
	t,
	globalSettings,
	onToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onToggle: (enabled: boolean) => void;
}) {
	return (
		<SettingsSection title={t("settings.rateLimitTracking")} helpTopicId="settings.rate-limits">
			<SettingsEntry anchor="rate-limit-tracking">
				<div>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.rateLimitTrackingDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.agentRateLimitTracking !== false}
						ariaLabel={t("settings.rateLimitTracking")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onToggle(globalSettings.agentRateLimitTracking === false)
						}
					/>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
