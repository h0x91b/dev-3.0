import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { useIsSimplifyViewApplied } from "../../hooks/useIsControlHidden";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

/**
 * Home for beta behaviour that is still labelled experimental and states its own
 * limitations. Most entries ship off; agent traffic ships on and can be turned off.
 *
 * Simplify View leads the section: it is a named preset (PRODUCT_UX_BIBLE.md
 * §5.10), not its own flag — turning it on writes a closed list of ids into
 * the same hidden-controls set a right-click "Hide" writes into. Its checked
 * state is derived (every preset id currently hidden), not stored, so
 * un-hiding one control from the panel's restore dropdown honestly un-checks
 * it here too. Off by default.
 */
export default function AdvancedExperienceSection({
	t,
	globalSettings,
	onTerminalBidiToggle,
	onAgentTrafficToggle,
	onSimplifyModeToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	onTerminalBidiToggle: (enabled: boolean) => void;
	onAgentTrafficToggle: (enabled: boolean) => void;
	onSimplifyModeToggle: (enabled: boolean) => void;
}) {
	const bidiEnabled = globalSettings.experimentalTerminalBidi === true;
	// Default-on, unlike its neighbours: absent is "never chose", not "off".
	const trafficEnabled = globalSettings.experimentalAgentTraffic !== false;
	const simplifyEnabled = useIsSimplifyViewApplied();

	return (
		<SettingsSection
			title={t("settings.categoryAdvancedExperience")}
			description={t("settings.categoryAdvancedExperienceDesc")}
			helpTopicId="settings.advancedExperience"
		>
			<SettingsEntry anchor="simplify-mode">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.simplifyMode")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.simplifyModeDesc")}</p>
					<SettingsToggle
						checked={simplifyEnabled}
						ariaLabel={t("settings.simplifyMode")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onSimplifyModeToggle(!simplifyEnabled)}
					/>
					<p className="text-fg-muted text-xs mt-2">
						{t("settings.simplifyModeCaveat")}
					</p>
				</div>
			</SettingsEntry>

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
		</SettingsSection>
	);
}
