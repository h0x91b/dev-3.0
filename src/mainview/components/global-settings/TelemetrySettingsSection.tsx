import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { telemetryOptOutSource } from "../../telemetry";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

/**
 * The one place telemetry can be switched off without rebuilding the app.
 *
 * When the environment already decided (`DEV3_TELEMETRY` / `DO_NOT_TRACK`, or a
 * build with telemetry compiled out) the toggle is locked and says which one did
 * it — a control that silently refuses to move is worse than no control.
 */
export default function TelemetrySettingsSection({
	t,
	globalSettings,
	onToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onToggle: (disabled: boolean) => void;
}) {
	const source = telemetryOptOutSource();
	const lockedByEnvironment = source === "env" || source === "do-not-track";
	// The toggle shows the user's stored CHOICE, not the live gate. Switching back on
	// cannot take effect until a relaunch, and a switch that refuses to move reads as
	// broken — so the control follows the choice and the note below explains the lag.
	const optedOut = globalSettings.telemetryDisabled === true;
	const checked = !lockedByEnvironment && !optedOut;
	// Chose "on" while this launch is still gated off: nothing resumes until restart.
	const resumesAfterRestart = checked && source !== null;

	return (
		<SettingsSection
			title={t("settings.telemetry")}
			description={t("settings.telemetryDesc")}
		>
			<SettingsEntry anchor="telemetry">
				<div>
					{/* Not a <label>: the control it heads is SettingsToggle, which carries
					    its own accessible name. A label with no association is never announced. */}
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.telemetryToggle")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.telemetryToggleDesc")}</p>
					<SettingsToggle
						checked={checked}
						disabled={lockedByEnvironment}
						ariaLabel={t("settings.telemetryToggle")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onToggle(checked)}
					/>
					<p className="text-fg-muted text-xs mt-2">
						{lockedByEnvironment
							? source === "do-not-track"
								? t("settings.telemetryLockedDoNotTrack")
								: t("settings.telemetryLockedEnv")
							: optedOut
								? t("settings.telemetryStoppedNow")
								: resumesAfterRestart
									? t("settings.telemetryResumesAfterRestart")
									: t("settings.telemetryEnvHint")}
					</p>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
