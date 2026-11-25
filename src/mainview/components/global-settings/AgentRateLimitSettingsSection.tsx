import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function AgentRateLimitSettingsSection({
	t,
	globalSettings,
	onToggle,
	onShowAccountToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onToggle: (enabled: boolean) => void;
	onShowAccountToggle: (enabled: boolean) => void;
}) {
	const tracking = globalSettings.agentRateLimitTracking !== false;
	return (
		<SettingsSection title={t("settings.rateLimitTracking")} helpTopicId="settings.rate-limits">
			<SettingsEntry anchor="rate-limit-tracking">
				<div>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.rateLimitTrackingDesc")}
					</p>
					<SettingsToggle
						checked={tracking}
						ariaLabel={t("settings.rateLimitTracking")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onToggle(globalSettings.agentRateLimitTracking === false)
						}
					/>
				</div>
			</SettingsEntry>
			<SettingsEntry anchor="rate-limit-statusline-account">
				<div className="mt-6">
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.statusLineShowAccount")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.statusLineShowAccountDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.statusLineShowAccount === true}
						disabled={!tracking}
						ariaLabel={t("settings.statusLineShowAccount")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onShowAccountToggle(globalSettings.statusLineShowAccount !== true)}
					/>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
