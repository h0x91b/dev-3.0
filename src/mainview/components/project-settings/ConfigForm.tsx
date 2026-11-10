import { useState } from "react";
import type { Dev3RepoConfig, SetupScriptLaunchMode } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { ListEditor, type ListEditorBrowse } from "../ListEditor";
import { openFolderPicker, openFolderPickerMulti } from "../../folder-picker";
import SettingsSection from "../global-settings/SettingsSection";
import { BranchPicker } from "./BranchPicker";
import { DevServersEditor } from "./DevServersEditor";
import { EnvVarsEditor, type EnvStorageScope } from "./EnvVarsEditor";
import { Field, ToggleSwitch, WarningNote } from "./fields";
import { SchemaConfigFields } from "./SchemaConfigFields";

// ---- Config form (shared between Repo and Local tabs) ----

interface ConfigFormProps {
	config: Dev3RepoConfig;
	onChange: (config: Dev3RepoConfig) => void;
	/** For each field, the inherited value from the lower-priority layer (shown as placeholder). */
	inherited?: Dev3RepoConfig;
	/** Show auto-detect for clone paths */
	projectId: string;
	/** Project path for "Open in Finder" on sparse checkout */
	projectPath?: string;
	/** Destination that owns env values, used for storage-specific safety copy. */
	envStorageScope: EnvStorageScope;
	/** Reports whether the env textarea currently holds unparseable lines. */
	onEnvErrorChange?: (hasError: boolean) => void;
}

export function ConfigForm({ config, onChange, inherited, projectId, projectPath, envStorageScope, onEnvErrorChange }: ConfigFormProps) {
	const t = useT();
	const [detecting, setDetecting] = useState(false);
	const [detectFeedback, setDetectFeedback] = useState<string | null>(null);
	const setupScriptLaunchMode = config.setupScriptLaunchMode ?? inherited?.setupScriptLaunchMode ?? "parallel";

	function update(field: keyof Dev3RepoConfig, value: Dev3RepoConfig[keyof Dev3RepoConfig]) {
		onChange({ ...config, [field]: value });
	}

	// Both path lists are stored relative to the repo root, so the picker is
	// locked inside it and hands back relative paths. Without a known root there
	// is nothing to be relative to, so the buttons stay away.
	const repoBrowse: ListEditorBrowse | undefined = projectPath
		? {
			label: t("folderPicker.browse"),
			rowLabel: t("folderPicker.browseInProject"),
			pickOne: () => openFolderPicker({
				confineTo: projectPath,
				confineLabel: t("folderPicker.projectRoot"),
				title: t("folderPicker.titleInProject"),
			}),
			pickMany: () => openFolderPickerMulti({
				confineTo: projectPath,
				confineLabel: t("folderPicker.projectRoot"),
				title: t("folderPicker.titleInProject"),
			}),
		}
		: undefined;

	async function runAutoDetect() {
		setDetecting(true);
		setDetectFeedback(null);
		try {
			const detected = await api.request.detectClonePaths({ projectId });
			if (detected.length > 0) {
				const existing = new Set(config.clonePaths ?? []);
				const merged = [...(config.clonePaths ?? []), ...detected.filter((p) => !existing.has(p))];
				update("clonePaths", merged);
				setDetectFeedback(t.plural("projectSettings.autoDetectFound", detected.length));
			} else {
				setDetectFeedback(t("projectSettings.autoDetectNone"));
			}
		} catch {
			setDetectFeedback(t("projectSettings.autoDetectNone"));
		}
		setDetecting(false);
	}

	function inheritedHint(field: keyof Dev3RepoConfig): string {
		const val = inherited?.[field];
		if (val === undefined || val === null) return "";
		if (Array.isArray(val)) return val.join(", ") || "";
		return String(val);
	}

	return (
		<div>
			<SettingsSection
				title={t("projectSettings.groupScripts")}
				description={t("projectSettings.groupScriptsDesc")}
			>
			{/* Setup Script */}
			<div data-config-keys="setupScript">
			<Field title={t("projectSettings.setupScript")} description={t("projectSettings.setupScriptDesc")}>
				<textarea
					value={config.setupScript ?? ""}
					onChange={(e) => update("setupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("setupScript") || "bun install"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.setupScript")}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</Field>
			</div>

			<div data-config-keys="setupScriptLaunchMode">
				<fieldset>
					<legend className="block text-fg text-sm font-semibold mb-2">
						{t("projectSettings.setupScriptLaunchMode")}
					</legend>
					<p className="text-fg-3 text-sm mb-3">
						{t("projectSettings.setupScriptLaunchModeDesc")}
					</p>
					<div role="radiogroup" aria-label={t("projectSettings.setupScriptLaunchMode")} className="grid gap-3 sm:grid-cols-3">
						{([
							{
								value: "parallel",
								title: t("projectSettings.setupScriptLaunchModeParallel"),
								description: t("projectSettings.setupScriptLaunchModeParallelDesc"),
							},
							{
								value: "blocking",
								title: t("projectSettings.setupScriptLaunchModeBlocking"),
								description: t("projectSettings.setupScriptLaunchModeBlockingDesc"),
							},
							{
								value: "single-pane",
								title: t("projectSettings.setupScriptLaunchModeSinglePane"),
								description: t("projectSettings.setupScriptLaunchModeSinglePaneDesc"),
							},
						] as const).map((option, index, options) => {
							const checked = setupScriptLaunchMode === option.value;
							return (
								<button
									key={option.value}
									type="button"
									role="radio"
									aria-checked={checked}
									aria-label={option.title}
									tabIndex={checked ? 0 : -1}
									onClick={() => update("setupScriptLaunchMode", option.value as SetupScriptLaunchMode)}
									onKeyDown={(event) => {
										if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
										event.preventDefault();
										const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
										const next = (index + step + options.length) % options.length;
										update("setupScriptLaunchMode", options[next].value as SetupScriptLaunchMode);
										const siblings = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
										siblings?.[next]?.focus();
									}}
									className={`rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
										checked
											? "border-accent/60 bg-accent/10"
											: "border-edge bg-raised hover:border-edge-active hover:bg-raised-hover"
									}`}
								>
									<div className="text-fg text-sm font-semibold">{option.title}</div>
									<div className="mt-1 text-fg-3 text-sm">{option.description}</div>
								</button>
							);
						})}
					</div>
				</fieldset>
			</div>

			{/* Dev servers: `devScript` as the row named `dev`, plus `devServers` */}
			<div data-config-keys="devScript devServers">
			<DevServersEditor
				devScript={config.devScript}
				devServers={config.devServers}
				placeholder={inheritedHint("devScript") || "bun run dev"}
				onChange={(patch) => {
					if (patch.devScript !== undefined) update("devScript", patch.devScript);
					if (patch.devServers !== undefined) update("devServers", patch.devServers);
				}}
			/>
			</div>

			{/* Cleanup Script */}
			<div data-config-keys="cleanupScript">
			<Field title={t("projectSettings.cleanupScript")} description={t("projectSettings.cleanupScriptDesc")}>
				<textarea
					value={config.cleanupScript ?? ""}
					onChange={(e) => update("cleanupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("cleanupScript") || "git worktree remove ."}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.cleanupScript")}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</Field>
			</div>

			{/* Environment Variables */}
			<div data-config-keys="env">
			<EnvVarsEditor
				env={config.env}
				storageScope={envStorageScope}
				onChange={(env) => update("env", env)}
				onErrorChange={onEnvErrorChange}
			/>
			</div>
			<SchemaConfigFields section="scripts" config={config} onChange={onChange} inherited={inherited} />
			</SettingsSection>

			<SettingsSection
				title={t("projectSettings.groupWorktree")}
				description={t("projectSettings.groupWorktreeDesc")}
			>
			{/* Clone Paths (CoW) */}
			<div data-config-keys="clonePaths">
				<span className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.clonePaths")}
				</span>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.clonePathsDesc")}
					</p>
					<button
						type="button"
						onClick={runAutoDetect}
						disabled={detecting}
						className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent/30 text-accent outline-none hover:bg-accent/10 hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
					>
						{detecting ? t("projectSettings.autoDetecting") : t("projectSettings.autoDetect")}
					</button>
				</div>
				{detectFeedback && (
					<p className="text-fg-3 text-xs mb-2" aria-live="polite">{detectFeedback}</p>
				)}
				<ListEditor
					items={config.clonePaths ?? []}
					onChange={(items) => {
						update("clonePaths", items);
						setDetectFeedback(null);
					}}
					placeholder={inheritedHint("clonePaths") || "node_modules"}
					addLabel={t("projectSettings.addClonePath")}
					removeLabel={t("listEditor.removeItem")}
					browse={repoBrowse}
				/>
			</div>

			{/* Worktree File Filter (Sparse Checkout) */}
			<div data-config-keys="sparseCheckoutEnabled sparseCheckoutPaths">
				<span className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.sparseCheckout")}
				</span>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.sparseCheckoutDesc")}
					</p>
					{(config.sparseCheckoutEnabled ?? false) && projectPath && (
						<button
							type="button"
							onClick={() => api.request.openFolder({ path: projectPath })}
							className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent/30 text-accent outline-none hover:bg-accent/10 hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.96]"
						>
							{t("projectSettings.sparseCheckoutOpenFinder")}
						</button>
					)}
				</div>
				<div className="flex items-center justify-between gap-4 mb-3">
					<span className="text-fg-2 text-sm">{t("projectSettings.sparseCheckoutAll")}</span>
					<ToggleSwitch
						checked={!(config.sparseCheckoutEnabled ?? false)}
						ariaLabel={t("projectSettings.sparseCheckoutAll")}
						onToggle={() => {
							const next = !(config.sparseCheckoutEnabled ?? false);
							const updates: Partial<Dev3RepoConfig> = { sparseCheckoutEnabled: next };
							if (next && !(config.sparseCheckoutPaths?.length)) {
								updates.sparseCheckoutPaths = [""];
							}
							onChange({ ...config, ...updates });
						}}
					/>
				</div>
				{(config.sparseCheckoutEnabled ?? false) && (
					<ListEditor
						items={config.sparseCheckoutPaths ?? []}
						onChange={(items) => update("sparseCheckoutPaths", items)}
						placeholder={t("projectSettings.sparseCheckoutPlaceholder")}
						addLabel={t("projectSettings.sparseCheckoutAddPath")}
						removeLabel={t("listEditor.removeItem")}
						browse={repoBrowse}
					/>
				)}
			</div>

			{/* Port Allocation */}
			<div data-config-keys="portCount">
				<label htmlFor="project-port-count" className="block text-fg text-sm font-semibold mb-1">
					{t("projectSettings.portCount")}
				</label>
				<p className="text-fg-3 text-sm mb-2">
					{t("projectSettings.portCountDesc")}
				</p>
				<input
					id="project-port-count"
					type="number"
					min={0}
					max={20}
					value={config.portCount ?? 0}
					onChange={(e) => update("portCount", Math.max(0, Math.min(20, parseInt(e.target.value) || 0)))}
					className="w-20 px-3 py-1.5 rounded-lg bg-base border border-edge text-fg text-sm tabular-nums outline-none focus:border-accent transition-colors"
				/>
			</div>
			<SchemaConfigFields section="worktree" config={config} onChange={onChange} inherited={inherited} />
			</SettingsSection>

			<SettingsSection
				title={t("projectSettings.groupGit")}
				description={t("projectSettings.groupGitDesc")}
			>
			{/* Default Base Branch */}
			<div data-config-keys="defaultBaseBranch">
			<Field title={t("projectSettings.baseBranch")} description={t("projectSettings.baseBranchDesc")}>
				<BranchPicker
					projectId={projectId}
					value={config.defaultBaseBranch ?? ""}
					onChange={(value) => update("defaultBaseBranch", value)}
					placeholder={inheritedHint("defaultBaseBranch") || "main"}
					label={t("projectSettings.baseBranch")}
					includeRemote={false}
				/>
			</Field>
			</div>

			<div data-config-keys="defaultCompareRef">
			<Field title={t("projectSettings.compareRef")} description={t("projectSettings.compareRefDesc")}>
				<BranchPicker
					projectId={projectId}
					value={config.defaultCompareRef ?? ""}
					onChange={(value) => update("defaultCompareRef", value)}
					placeholder={inheritedHint("defaultCompareRef") || config.defaultBaseBranch || inherited?.defaultBaseBranch || "main"}
					label={t("projectSettings.compareRef")}
					includeRemote={true}
				/>
			</Field>
			</div>

			{/* Peer Review Column */}
			<div data-config-keys="peerReviewEnabled" className="flex items-center justify-between gap-4">
				<div>
					<span className="block text-fg text-sm font-semibold mb-1">
						{t("projectSettings.peerReview")}
					</span>
					<p className="text-fg-3 text-sm">
						{t("projectSettings.peerReviewDesc")}
					</p>
				</div>
				<ToggleSwitch
					checked={config.peerReviewEnabled ?? true}
					ariaLabel={t("projectSettings.peerReview")}
					onToggle={() => update("peerReviewEnabled", !(config.peerReviewEnabled ?? true))}
				/>
			</div>

			{/* Automatic AI Review */}
			<div data-config-keys="autoReviewEnabled" className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<div>
						<span className="block text-fg text-sm font-semibold mb-1">
							{t("projectSettings.autoReview")}
						</span>
						<p className="text-fg-3 text-sm">
							{t("projectSettings.autoReviewDesc")}
						</p>
					</div>
					<ToggleSwitch
						checked={config.autoReviewEnabled ?? false}
						ariaLabel={t("projectSettings.autoReviewEnabled")}
						onToggle={() => update("autoReviewEnabled", !(config.autoReviewEnabled ?? false))}
					/>
				</div>
				{(config.autoReviewEnabled ?? false) && <WarningNote>{t("projectSettings.autoReviewWarning")}</WarningNote>}
			</div>
			<SchemaConfigFields section="git" config={config} onChange={onChange} inherited={inherited} />
			</SettingsSection>
		</div>
	);
}
