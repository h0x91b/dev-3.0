import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import BrowserNotificationsSetting from "./BrowserNotificationsSetting";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function NotificationSettingsSection({
	t,
	globalSettings,
	onSoundToggle,
	onFocusModeToggle,
	onWatchByDefaultToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onSoundToggle: (enabled: boolean) => void;
	onFocusModeToggle: (enabled: boolean) => void;
	onWatchByDefaultToggle: (enabled: boolean) => void;
}) {
	return (
		<SettingsSection
			title={t("settings.categoryNotifications")}
			helpTopicId="settings.notifications"
		>
			<SettingsEntry anchor="focus-mode">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.focusMode")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.focusModeDesc")}</p>
					<SettingsToggle
						checked={globalSettings.focusMode === true}
						ariaLabel={t("settings.focusMode")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onFocusModeToggle(globalSettings.focusMode !== true)}
					/>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="watch-by-default">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.watchByDefault")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.watchByDefaultDesc")}</p>
					<SettingsToggle
						checked={globalSettings.watchByDefault === true}
						ariaLabel={t("settings.watchByDefault")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onWatchByDefaultToggle(globalSettings.watchByDefault !== true)
						}
					/>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="task-complete-sound">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.taskCompleteSound")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.taskCompleteSoundDesc")}</p>
					<SettingsToggle
						checked={globalSettings.playSoundOnTaskComplete !== false}
						ariaLabel={t("settings.taskCompleteSound")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onSoundToggle(globalSettings.playSoundOnTaskComplete === false)
						}
					/>
				</div>
			</SettingsEntry>

			<BrowserNotificationsSetting t={t} />
		</SettingsSection>
	);
}
