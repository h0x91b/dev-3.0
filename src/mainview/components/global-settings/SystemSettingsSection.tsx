import type { GlobalSettings } from "../../../shared/types";
import type { UpdateChannel } from "../../../shared/update-channel";
import type { TFunction } from "../../i18n";
import BrowserNotificationsSetting from "./BrowserNotificationsSetting";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function SystemSettingsSection({
	t,
	globalSettings,
	caffeinateAvailable,
	canaryAvailable,
	onUpdateChannelChange,
	onRemoteSilentUpdateToggle,
	onPreventSleepToggle,
	onConfirmBeforeQuitToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	caffeinateAvailable: boolean;
	/** The canary feed carries a build for this host. False on platforms it does not publish. */
	canaryAvailable: boolean;
	onUpdateChannelChange: (channel: UpdateChannel) => void;
	onRemoteSilentUpdateToggle: (enabled: boolean) => void;
	onPreventSleepToggle: (enabled: boolean) => void;
	onConfirmBeforeQuitToggle: (enabled: boolean) => void;
}) {
	return (
		<SettingsSection title={t("settings.categorySystem")} helpTopicId="settings.system">
			<SettingsEntry anchor="update-channel">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.updateChannel")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.updateChannelDesc")}
					</p>
					<select
						value={globalSettings.updateChannel}
						onChange={(event) => onUpdateChannelChange(event.target.value as UpdateChannel)}
						disabled={!canaryAvailable}
						className={`w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none appearance-none${
							canaryAvailable ? "" : " cursor-not-allowed opacity-50"
						}`}
					>
						<option value="stable">{t("settings.updateChannelStable")}</option>
						<option value="canary">{t("settings.updateChannelCanary")}</option>
					</select>
					{!canaryAvailable ? (
						// Says WHY rather than leaving a dimmed control that reads as broken. The
						// channel publishes per platform, and this machine is not one of them yet.
						<p className="text-fg-muted text-xs mt-2">{t("settings.updateChannelUnavailableHere")}</p>
					) : null}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="remote-silent-update">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.remoteSilentUpdate")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.remoteSilentUpdateDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.remoteSilentUpdate !== false}
						ariaLabel={t("settings.remoteSilentUpdate")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onRemoteSilentUpdateToggle(globalSettings.remoteSilentUpdate === false)}
					/>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="prevent-sleep">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.preventSleep")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.preventSleepDesc")}
					</p>
					<SettingsToggle
						checked={
							globalSettings.preventSleepWhileRunning !== false &&
							caffeinateAvailable
						}
						disabled={!caffeinateAvailable}
						ariaLabel={t("settings.preventSleep")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onPreventSleepToggle(
								globalSettings.preventSleepWhileRunning === false,
							)
						}
					/>
					{!caffeinateAvailable ? (
						<p className="text-fg-muted text-xs mt-2">
							{t("settings.preventSleepNotAvailable")}
						</p>
					) : null}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="confirm-before-quit">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.confirmBeforeQuit")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.confirmBeforeQuitDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.skipQuitDialog !== true}
						ariaLabel={t("settings.confirmBeforeQuit")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onConfirmBeforeQuitToggle(
								globalSettings.skipQuitDialog === true,
							)
						}
					/>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="browser-notifications">
				<BrowserNotificationsSetting t={t} />
			</SettingsEntry>
		</SettingsSection>
	);
}
