import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

interface DeveloperToolsSectionProps {
	t: TFunction;
	cliInstallStatus: string | null;
	/** Localized "dev3-self now points at …" line, shown after a successful install. */
	cliArmedInstance: string | null;
	onInstallDev3Cli: () => void;
}

export default function DeveloperToolsSection({
	t,
	cliInstallStatus,
	cliArmedInstance,
	onInstallDev3Cli,
}: DeveloperToolsSectionProps) {
	return (
		<SettingsEntry anchor="developer-tools">
		<SettingsSection
			title={t("settings.devTools")}
			description={t("settings.devToolsDesc")}
			helpTopicId="settings.devtools"
		>
			<div className="flex items-center gap-3">
				<button
					onClick={onInstallDev3Cli}
					className="px-4 py-2 bg-raised hover:bg-raised-hover text-fg text-sm rounded-lg transition-colors border border-edge"
				>
					{t("settings.installDev3Cli")}
				</button>
				{cliInstallStatus ? (
					<span
						className="text-fg-muted text-xs truncate max-w-md"
						title={cliInstallStatus}
					>
						→ {cliInstallStatus}
					</span>
				) : null}
			</div>
			<p className="text-fg-muted text-xs mt-1">
				{t("settings.installDev3CliDesc")}
			</p>
			{cliArmedInstance ? (
				<p className="text-fg-2 text-xs mt-1">{cliArmedInstance}</p>
			) : null}
		</SettingsSection>
		</SettingsEntry>
	);
}
