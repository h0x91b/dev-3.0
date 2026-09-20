import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function AdvancedExperienceSection({
	t,
	globalSettings,
	freezeDiagnostics,
	onTerminalBidiToggle,
	onAgentTrafficToggle,
	onFreezeDiagnosticsToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	/** Null until the host answers — the row stays inert rather than guessing
	 *  that the machine running the app can be sampled. */
	freezeDiagnostics: { supported: boolean; running: boolean; directory: string } | null;
	onTerminalBidiToggle: (enabled: boolean) => void;
	onAgentTrafficToggle: (enabled: boolean) => void;
	onFreezeDiagnosticsToggle: (enabled: boolean) => void;
}) {
	// Default-on: absent is "never chose", not "off".
	const bidiEnabled = globalSettings.experimentalTerminalBidi !== false;
	const trafficEnabled = globalSettings.experimentalAgentTraffic !== false;
	// Default-off: only an explicit true opts in.
	const freezeEnabled = globalSettings.freezeDiagnosticsEnabled === true;
	const freezeSupported = freezeDiagnostics?.supported === true;

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

			<SettingsEntry anchor="experimental-agent-traffic">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.agentTraffic")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.agentTrafficDesc")}</p>
					<SettingsToggle
						checked={trafficEnabled}
						ariaLabel={t("settings.agentTraffic")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onAgentTrafficToggle(!trafficEnabled)}
					/>
					<p className="text-fg-muted text-xs mt-2">
						{t("settings.agentTrafficCaveat")}
					</p>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="freeze-diagnostics">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.freezeDiagnostics")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.freezeDiagnosticsDesc")}</p>
					{freezeDiagnostics && !freezeSupported ? (
						<p className="text-fg-muted text-sm mb-3">
							{t("settings.freezeDiagnosticsUnsupported")}
						</p>
					) : null}
					<SettingsToggle
						checked={freezeSupported && freezeEnabled}
						disabled={!freezeSupported}
						ariaLabel={t("settings.freezeDiagnostics")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onFreezeDiagnosticsToggle(!freezeEnabled)}
					/>
					{freezeSupported ? (
						<p className="text-fg-muted text-xs mt-2 break-all">
							{t("settings.freezeDiagnosticsPath", {
								directory: freezeDiagnostics?.directory ?? "",
							})}
						</p>
					) : null}
					<p className="text-fg-muted text-xs mt-2">
						{t("settings.freezeDiagnosticsCaveat")}
					</p>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
