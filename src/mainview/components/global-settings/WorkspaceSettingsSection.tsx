import type { ExternalApp, GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

interface WorkspaceSettingsSectionProps {
	t: TFunction;
	globalSettings: GlobalSettings;
	onAddExternalApp: () => void;
	onDeleteExternalApp: (appId: string) => void;
	onPickCloneBaseDirectory: () => void;
	onUpdateExternalApp: (appId: string, patch: Partial<ExternalApp>) => void;
}

export default function WorkspaceSettingsSection({
	t,
	globalSettings,
	onAddExternalApp,
	onDeleteExternalApp,
	onPickCloneBaseDirectory,
	onUpdateExternalApp,
}: WorkspaceSettingsSectionProps) {
	return (
		<SettingsSection title={t("settings.categoryWorkspace")} helpTopicId="settings.workspace">
			<SettingsEntry anchor="clone-directory">
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.cloneBaseDir")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.cloneBaseDirDesc")}
				</p>
				<div className="flex gap-2">
					<div className="flex-1 px-4 py-3 bg-raised border border-edge rounded-xl text-sm font-mono truncate">
						{globalSettings.cloneBaseDirectory ? (
							<span className="text-fg">
								{globalSettings.cloneBaseDirectory}
							</span>
						) : (
							<span className="text-fg-muted">
								{t("settings.cloneBaseDirNotSet")}
							</span>
						)}
					</div>
					<button
						onClick={onPickCloneBaseDirectory}
						className="px-4 py-3 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active transition-colors flex-shrink-0"
					>
						{t("settings.browse")}
					</button>
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="external-apps">
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.externalApps")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.externalAppsDesc")}
				</p>
				<div className="space-y-2 mb-3">
					{(globalSettings.externalApps ?? []).map((app) => (
						<div
							key={app.id}
							className="flex items-center gap-2 bg-raised border border-edge rounded-xl px-4 py-3"
						>
							<div className="flex-1 space-y-2">
								<input
									type="text"
									value={app.name}
									onChange={(event) =>
										onUpdateExternalApp(app.id, {
											name: event.target.value,
										})
									}
									placeholder={t("settings.externalAppName")}
									className="w-full px-3 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
								/>
								<input
									type="text"
									value={app.macAppName}
									onChange={(event) =>
										onUpdateExternalApp(app.id, {
											macAppName: event.target.value,
										})
									}
									placeholder={t("settings.externalAppMacName")}
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									className="w-full px-3 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
								/>
							</div>
							<button
								onClick={() => onDeleteExternalApp(app.id)}
								className="text-danger text-xs hover:underline shrink-0 px-2"
							>
								×
							</button>
						</div>
					))}
				</div>
				<button
					onClick={onAddExternalApp}
					className="px-4 py-2 text-accent text-sm font-semibold hover:bg-accent/10 rounded-lg transition-colors"
				>
					+ {t("settings.addExternalApp")}
				</button>
			</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
