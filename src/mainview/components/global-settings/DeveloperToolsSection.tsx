import type { TFunction } from "../../i18n";
import SettingsSection from "./SettingsSection";

interface DeveloperToolsSectionProps {
	t: TFunction;
	cliInstallStatus: string | null;
	onInstallDev3Cli: () => void;
}

export default function DeveloperToolsSection({
	t,
	cliInstallStatus,
	onInstallDev3Cli,
}: DeveloperToolsSectionProps) {
	return (
		<SettingsSection title={t("settings.devTools")}>
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
		</SettingsSection>
	);
}
