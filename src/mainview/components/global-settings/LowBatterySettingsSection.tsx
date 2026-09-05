import { useCallback, useEffect, useState } from "react";
import type { GlobalSettings, LowBatteryStatus } from "../../../shared/types";
import { api } from "../../rpc";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

/**
 * The one switch for the low-battery answer format, off until the user turns it on.
 * The row does more than toggle: when the user already had their own Claude Code
 * output style, dev3 leaves it selected, and the row has to say so.
 */
export default function LowBatterySettingsSection({
	t,
	globalSettings,
	onToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onToggle: (enabled: boolean) => void;
}) {
	const [status, setStatus] = useState<LowBatteryStatus | null>(null);
	const enabled = globalSettings.lowBatteryEnabled === true;

	const refresh = useCallback(() => {
		api.request.getLowBatteryStatus().then(setStatus).catch(() => setStatus(null));
	}, []);

	useEffect(refresh, [refresh, enabled]);

	const switchStyle = useCallback(() => {
		api.request.selectLowBatteryStyle().then(setStatus).catch(() => {});
	}, []);

	const outcome = status?.outcome;

	return (
		<SettingsSection title={t("settings.lowBattery")}>
			<SettingsEntry anchor="low-battery">
				<div>
					<p className="text-fg-3 text-sm mb-3">{t("settings.lowBatteryDesc")}</p>
					<SettingsToggle
						checked={enabled}
						ariaLabel={t("settings.lowBattery")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onToggle(!enabled)}
					/>
					{enabled && outcome ? (
						<div className="mt-3 space-y-2 text-sm">
							{outcome.kind === "user-style-kept" ? (
								<div className="flex flex-wrap items-center gap-3">
									<span className="text-fg-2">
										{t("settings.lowBatteryStyleKept", { style: outcome.style })}
									</span>
									<button
										type="button"
										onClick={switchStyle}
										className="px-3 py-1 rounded-md bg-accent hover:bg-accent-hover text-white text-xs"
									>
										{t("settings.lowBatterySwitchStyle")}
									</button>
								</div>
							) : null}
							{outcome.kind === "already-on" ? (
								<p className="text-fg-3">
									{t("settings.lowBatteryAlreadyOn", { style: outcome.style })}
								</p>
							) : null}
							{outcome.kind === "selected" ? (
								<p className="text-fg-3">{t("settings.lowBatterySelected")}</p>
							) : null}
							<p className="text-fg-muted text-xs">{t("settings.lowBatteryOtherHarnesses")}</p>
						</div>
					) : null}
					{status ? (
						<p className="text-fg-muted text-xs mt-2">
							{t("settings.lowBatteryRevision", { revision: status.revision.slice(0, 8) })}
						</p>
					) : null}
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
