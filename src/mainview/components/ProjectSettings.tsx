import { useState, useEffect, useRef, useCallback, type Dispatch, type MutableRefObject } from "react";
import type { CodingAgent, ColumnAgentConfig, CustomColumn, Dev3RepoConfig, Label, Project } from "../../shared/types";
import { CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS, DEFAULT_REVIEW_PROMPT, LABEL_COLORS } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { ListEditor } from "./ListEditor";

interface LabelRowProps {
	label: Label;
	saving: boolean;
	onUpdate: (name: string, color: string) => void;
	onDelete: () => void;
	nameLabel: string;
	deleteLabel: string;
}

function LabelRow({ label, saving, onUpdate, onDelete, nameLabel, deleteLabel }: LabelRowProps) {
	const [name, setName] = useState(label.name);
	const [color, setColor] = useState(label.color);

	function commitUpdate(newName = name, newColor = color) {
		if (newName.trim() && (newName !== label.name || newColor !== label.color)) {
			onUpdate(newName.trim(), newColor);
		}
	}

	return (
		<div className="flex items-center gap-2 p-2.5 bg-raised rounded-xl border border-edge">
			{/* Color dot (shows current color) */}
			<div
				className="w-4 h-4 rounded-full flex-shrink-0 border border-edge-active"
				style={{ background: color }}
			/>
			{/* Name input */}
			<input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onBlur={() => commitUpdate()}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.currentTarget.blur();
					}
				}}
				aria-label={nameLabel}
				placeholder={nameLabel}
				disabled={saving}
				className="flex-1 bg-transparent text-fg text-sm outline-none placeholder-fg-muted min-w-0"
			/>
			{/* Color palette */}
			<div className="flex items-center gap-1 flex-shrink-0">
				{LABEL_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						onClick={() => {
							setColor(c);
							commitUpdate(name, c);
						}}
						disabled={saving}
						className={`w-3.5 h-3.5 rounded-full transition-transform hover:scale-125 ${
							c === color ? "ring-2 ring-offset-1 ring-fg/30" : ""
						}`}
						style={{ background: c }}
						title={c}
					/>
				))}
			</div>
			{/* Delete */}
			<button
				type="button"
				onClick={onDelete}
				disabled={saving}
				className="ml-1 w-6 h-6 flex items-center justify-center rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0"
				title={deleteLabel}
			>
				<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	);
}

interface CustomColumnRowProps {
	column: CustomColumn;
	saving: boolean;
	onUpdate: (name: string, color: string, llmInstruction: string, agentConfig?: ColumnAgentConfig | null) => void;
	onDelete: () => void;
	availableAgents: CodingAgent[];
}

function CustomColumnRow({ column, saving, onUpdate, onDelete, availableAgents }: CustomColumnRowProps) {
	const t = useT();
	const [name, setName] = useState(column.name);
	const [color, setColor] = useState(column.color);
	const [llmInstruction, setLlmInstruction] = useState(column.llmInstruction);
	const [agentEnabled, setAgentEnabled] = useState(!!column.agentConfig);
	const [agentId, setAgentId] = useState(column.agentConfig?.agentId ?? "builtin-claude");
	const [configId, setConfigId] = useState(column.agentConfig?.configId ?? "claude-default");
	const [agentPrompt, setAgentPrompt] = useState(column.agentConfig?.prompt ?? "");

	function buildAgentConfig(): ColumnAgentConfig | null {
		if (!agentEnabled) return null;
		return { agentId, configId, prompt: agentPrompt };
	}

	function commitUpdate(newName = name, newColor = color, newInstruction = llmInstruction, newAgentConfig?: ColumnAgentConfig | null) {
		const trimmedName = newName.trim();
		if (!trimmedName) return;
		onUpdate(trimmedName, newColor, newInstruction, newAgentConfig !== undefined ? newAgentConfig : buildAgentConfig());
	}

	const isOverLimit = llmInstruction.length > CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS;

	return (
		<div className="p-3 bg-raised rounded-xl border border-edge space-y-2.5">
			{/* Name + color + delete */}
			<div>
				<div className="flex items-center justify-between mb-1">
					<label className="text-fg-3 text-xs">{t("customColumns.columnName")}</label>
					<button
						type="button"
						onClick={onDelete}
						disabled={saving}
						className="w-5 h-5 flex items-center justify-center rounded text-fg-3 hover:text-danger hover:bg-danger/10 transition-colors"
						title={t("customColumns.deleteColumn")}
					>
						<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="flex items-center gap-2">
					<div
						className="w-3.5 h-3.5 rounded-full flex-shrink-0"
						style={{ background: color }}
					/>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => commitUpdate()}
						onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
						aria-label={t("customColumns.columnName")}
						placeholder={t("customColumns.columnName")}
						disabled={saving}
						className="flex-1 px-3 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors min-w-0"
					/>
					{/* Color palette */}
					<div className="flex items-center gap-1 flex-shrink-0">
						{LABEL_COLORS.map((c) => (
							<button
								key={c}
								type="button"
								onClick={() => { setColor(c); commitUpdate(name, c, llmInstruction); }}
								disabled={saving}
								className={`w-3.5 h-3.5 rounded-full transition-transform hover:scale-125 ${c === color ? "ring-2 ring-offset-1 ring-fg/30" : ""}`}
								style={{ background: c }}
								title={c}
							/>
						))}
					</div>
				</div>
			</div>
			{/* LLM instruction */}
			<div>
				<label className="block text-fg-3 text-xs mb-1">{t("customColumns.llmInstruction")}</label>
				<textarea
					value={llmInstruction}
					onChange={(e) => setLlmInstruction(e.target.value)}
					onBlur={() => commitUpdate()}
					placeholder={t("customColumns.llmInstructionPlaceholder")}
					disabled={saving}
					rows={2}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-none"
				/>
				<div className={`text-right text-xs mt-0.5 ${isOverLimit ? "text-danger" : "text-fg-muted"}`}>
					{t("customColumns.charCount", { count: String(llmInstruction.length), max: String(CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS) })}
				</div>
			</div>
			{/* Column Agent */}
			<div className="border-t border-edge/50 pt-2.5">
				<div className="flex items-center justify-between mb-2">
					<div>
						<label className="text-fg-3 text-xs font-medium">{t("columnAgent.title")}</label>
						<p className="text-fg-muted text-[0.65rem]">{t("columnAgent.desc")}</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={agentEnabled}
						aria-label={t("columnAgent.enable")}
						onClick={() => {
							const next = !agentEnabled;
							setAgentEnabled(next);
							commitUpdate(name, color, llmInstruction, next ? { agentId, configId, prompt: agentPrompt } : null);
						}}
						className={`relative flex-shrink-0 ml-3 w-8 h-5 rounded-full transition-colors focus:outline-none ${agentEnabled ? "bg-accent" : "bg-edge-active"}`}
					>
						<span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${agentEnabled ? "translate-x-3" : "translate-x-0"}`} />
					</button>
				</div>
				{agentEnabled && (
					<div className="space-y-2 pl-1">
						<div className="flex items-center gap-2">
							<label className="text-fg-3 text-xs w-20 flex-shrink-0">{t("columnAgent.agent")}</label>
							<select
								value={agentId}
								onChange={(e) => {
									setAgentId(e.target.value);
									const agent = availableAgents.find((a) => a.id === e.target.value);
									if (agent?.configurations?.length) {
										setConfigId(agent.configurations[0].id);
									}
								}}
								onBlur={() => commitUpdate()}
								className="flex-1 px-2 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-xs outline-none focus:border-accent/40 transition-colors"
							>
								{availableAgents.map((a) => (
									<option key={a.id} value={a.id}>{a.name}</option>
								))}
							</select>
						</div>
						<div className="flex items-center gap-2">
							<label className="text-fg-3 text-xs w-20 flex-shrink-0">{t("columnAgent.config")}</label>
							<select
								value={configId}
								onChange={(e) => setConfigId(e.target.value)}
								onBlur={() => commitUpdate()}
								className="flex-1 px-2 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-xs outline-none focus:border-accent/40 transition-colors"
							>
								{(availableAgents.find((a) => a.id === agentId)?.configurations ?? []).map((c) => (
									<option key={c.id} value={c.id}>{c.name || c.id}</option>
								))}
							</select>
						</div>
						<div>
							<label className="block text-fg-3 text-xs mb-1">{t("columnAgent.prompt")}</label>
							<textarea
								value={agentPrompt}
								onChange={(e) => setAgentPrompt(e.target.value)}
								onBlur={() => commitUpdate()}
								placeholder={t("columnAgent.promptPlaceholder")}
								disabled={saving}
								rows={3}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-2 py-1.5 bg-elevated border border-edge rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y font-mono"
							/>
							<p className="text-fg-muted text-[0.6rem] mt-1">{t("columnAgent.hint")}</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// ---- Config form (shared between Repo and Local tabs) ----

interface ConfigFormProps {
	config: Dev3RepoConfig;
	onChange: (config: Dev3RepoConfig) => void;
	/** For each field, the inherited value from the lower-priority layer (shown as placeholder). */
	inherited?: Dev3RepoConfig;
	saving: boolean;
	onSave: () => void;
	saveLabel: string;
	savingLabel: string;
	/** Show auto-detect for clone paths */
	projectId: string;
	/** Project path for "Open in Finder" on sparse checkout */
	projectPath?: string;
}

function ConfigForm({ config, onChange, inherited, saving, onSave, saveLabel, savingLabel, projectId, projectPath }: ConfigFormProps) {
	const t = useT();
	const [detecting, setDetecting] = useState(false);
	const [detectFeedback, setDetectFeedback] = useState<string | null>(null);

	function update(field: keyof Dev3RepoConfig, value: Dev3RepoConfig[keyof Dev3RepoConfig]) {
		onChange({ ...config, [field]: value });
	}

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
		<div className="space-y-7">
			{/* Setup Script */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.setupScript")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("projectSettings.setupScriptDesc")}
				</p>
				<textarea
					value={config.setupScript ?? ""}
					onChange={(e) => update("setupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("setupScript") || "bun install"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</div>

			{/* Clone Paths (CoW) */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.clonePaths")}
				</label>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.clonePathsDesc")}
					</p>
					<button
						type="button"
						onClick={runAutoDetect}
						disabled={detecting}
						className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg border border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/50 transition-all disabled:opacity-50"
					>
						{detecting ? t("projectSettings.autoDetecting") : t("projectSettings.autoDetect")}
					</button>
				</div>
				{detectFeedback && (
					<p className="text-fg-3 text-xs mb-2">{detectFeedback}</p>
				)}
				<ListEditor
					items={config.clonePaths ?? []}
					onChange={(items) => {
						update("clonePaths", items);
						setDetectFeedback(null);
					}}
					placeholder={inheritedHint("clonePaths") || "node_modules"}
					addLabel={t("projectSettings.addClonePath")}
				/>
			</div>

			{/* Dev Script */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.devScript")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("projectSettings.devScriptDesc")}
				</p>
				<textarea
					value={config.devScript ?? ""}
					onChange={(e) => update("devScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("devScript") || "bun run dev"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</div>

			{/* Cleanup Script */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.cleanupScript")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("projectSettings.cleanupScriptDesc")}
				</p>
				<textarea
					value={config.cleanupScript ?? ""}
					onChange={(e) => update("cleanupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("cleanupScript") || "git worktree remove ."}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</div>

			{/* Default Base Branch */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.baseBranch")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("projectSettings.baseBranchDesc")}
				</p>
				<input
					type="text"
					value={config.defaultBaseBranch ?? ""}
					onChange={(e) => update("defaultBaseBranch", e.target.value)}
					placeholder={inheritedHint("defaultBaseBranch") || "main"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
				/>
			</div>

			{/* Peer Review Column */}
			<div>
				<div className="flex items-center justify-between">
					<div>
						<label className="block text-fg text-sm font-semibold mb-1">
							{t("projectSettings.peerReview")}
						</label>
						<p className="text-fg-3 text-sm">
							{t("projectSettings.peerReviewDesc")}
						</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={config.peerReviewEnabled ?? true}
						aria-label={t("projectSettings.peerReview")}
						onClick={() => update("peerReviewEnabled", !(config.peerReviewEnabled ?? true))}
						className={`relative flex-shrink-0 ml-4 w-10 h-6 rounded-full transition-colors focus:outline-none ${
							(config.peerReviewEnabled ?? true) ? "bg-accent" : "bg-edge-active"
						}`}
					>
						<span
							className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
								(config.peerReviewEnabled ?? true) ? "translate-x-4" : "translate-x-0"
							}`}
						/>
					</button>
				</div>
			</div>

			{/* Worktree File Filter (Sparse Checkout) */}
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.sparseCheckout")}
				</label>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.sparseCheckoutDesc")}
					</p>
					{(config.sparseCheckoutEnabled ?? false) && projectPath && (
						<button
							type="button"
							onClick={() => api.request.openFolder({ path: projectPath })}
							className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg border border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/50 transition-all"
						>
							{t("projectSettings.sparseCheckoutOpenFinder")}
						</button>
					)}
				</div>
				<div className="flex items-center justify-between mb-3">
					<span className="text-fg-2 text-sm">{t("projectSettings.sparseCheckoutAll")}</span>
					<button
						type="button"
						role="switch"
						aria-checked={!(config.sparseCheckoutEnabled ?? false)}
						aria-label={t("projectSettings.sparseCheckoutAll")}
						onClick={() => {
							const next = !(config.sparseCheckoutEnabled ?? false);
							const updates: Partial<Dev3RepoConfig> = { sparseCheckoutEnabled: next };
							if (next && !(config.sparseCheckoutPaths?.length)) {
								updates.sparseCheckoutPaths = [""];
							}
							onChange({ ...config, ...updates });
						}}
						className={`relative flex-shrink-0 ml-4 w-10 h-6 rounded-full transition-colors focus:outline-none ${
							!(config.sparseCheckoutEnabled ?? false) ? "bg-accent" : "bg-edge-active"
						}`}
					>
						<span
							className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
								!(config.sparseCheckoutEnabled ?? false) ? "translate-x-4" : "translate-x-0"
							}`}
						/>
					</button>
				</div>
				{(config.sparseCheckoutEnabled ?? false) && (
					<ListEditor
						items={config.sparseCheckoutPaths ?? []}
						onChange={(items) => update("sparseCheckoutPaths", items)}
						placeholder={t("projectSettings.sparseCheckoutPlaceholder")}
						addLabel={t("projectSettings.sparseCheckoutAddPath")}
					/>
				)}
			</div>

			{/* Save Button */}
			<div>
				<button
					onClick={onSave}
					disabled={saving}
					className="px-6 py-2.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover disabled:opacity-50 shadow-lg shadow-accent/20 transition-all active:scale-95"
				>
					{saving ? savingLabel : saveLabel}
				</button>
			</div>
		</div>
	);
}

// ---- Main component ----

type ConfigTab = "repo" | "local";

interface NavigationGuard {
	isDirty: () => boolean;
	onSave: () => Promise<void>;
}

interface ProjectSettingsProps {
	projectId: string;
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
}

function ProjectSettings({
	projectId,
	projects,
	dispatch,
	navigate: _navigate,
	navigationGuardRef,
}: ProjectSettingsProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	const [activeTab, setActiveTab] = useState<ConfigTab>("repo");
	const [repoConfig, setRepoConfig] = useState<Dev3RepoConfig>({});
	const [localConfig, setLocalConfig] = useState<Dev3RepoConfig>({});
	const [savingRepo, setSavingRepo] = useState(false);
	const [savingLocal, setSavingLocal] = useState(false);
	const [labelSaving, setLabelSaving] = useState<string | null>(null);
	const [columnSaving, setColumnSaving] = useState<string | null>(null);
	const configsLoaded = useRef(false);
	const loadedRepoConfig = useRef<Dev3RepoConfig>({});
	const loadedLocalConfig = useRef<Dev3RepoConfig>({});

	// Load both config files on mount
	useEffect(() => {
		if (!configsLoaded.current && project) {
			configsLoaded.current = true;
			api.request.getProjectConfigs({ projectId }).then(({ repo, local }) => {
				setRepoConfig(repo);
				setLocalConfig(local);
				loadedRepoConfig.current = repo;
				loadedLocalConfig.current = local;
			}).catch(() => {});
		}
	}, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const configsEqual = useCallback((a: Dev3RepoConfig, b: Dev3RepoConfig) => {
		const keysToCheck: (keyof Dev3RepoConfig)[] = [
			"setupScript", "devScript", "cleanupScript", "defaultBaseBranch",
			"peerReviewEnabled", "sparseCheckoutEnabled",
		];
		for (const k of keysToCheck) {
			if ((a[k] ?? "") !== (b[k] ?? "")) return false;
		}
		const arrA = (a.clonePaths ?? []).join("\0");
		const arrB = (b.clonePaths ?? []).join("\0");
		if (arrA !== arrB) return false;
		const spA = (a.sparseCheckoutPaths ?? []).join("\0");
		const spB = (b.sparseCheckoutPaths ?? []).join("\0");
		if (spA !== spB) return false;
		return true;
	}, []);

	const isDirty = useCallback(() => {
		return !configsEqual(repoConfig, loadedRepoConfig.current) ||
			!configsEqual(localConfig, loadedLocalConfig.current);
	}, [repoConfig, localConfig, configsEqual]);

	const handleSaveRef = useRef<() => Promise<void>>(async () => {});

	// Register navigation guard
	useEffect(() => {
		if (navigationGuardRef) {
			navigationGuardRef.current = {
				isDirty,
				onSave: () => handleSaveRef.current(),
			};
		}
		return () => {
			if (navigationGuardRef) navigationGuardRef.current = null;
		};
	}, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

	// AI Review state (stored as builtinColumnAgents["review-by-ai"])
	const reviewConfig = project?.builtinColumnAgents?.["review-by-ai"];
	const [aiReviewEnabled, setAiReviewEnabled] = useState(reviewConfig !== undefined ? true : project?.builtinColumnAgents === undefined);
	const [aiReviewAgentId, setAiReviewAgentId] = useState(reviewConfig?.agentId ?? "builtin-claude");
	const [aiReviewConfigId, setAiReviewConfigId] = useState(reviewConfig?.configId ?? "claude-bypass-sonnet");
	const [aiReviewPrompt, setAiReviewPrompt] = useState(reviewConfig?.prompt || DEFAULT_REVIEW_PROMPT);
	const [availableAgents, setAvailableAgents] = useState<CodingAgent[]>([]);

	// Load available agents for AI Review dropdowns
	useEffect(() => {
		api.request.getAgents().then(setAvailableAgents).catch(() => {});
	}, []);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	async function handleAddLabel() {
		if (!project) return;
		setLabelSaving("new");
		try {
			const label = await api.request.createLabel({ projectId, name: "New label" });
			const updated: Project = { ...project, labels: [...(project.labels ?? []), label] };
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("labels.failedCreate", { error: String(err) }));
		}
		setLabelSaving(null);
	}

	async function handleUpdateLabel(labelId: string, name: string, color: string) {
		if (!project) return;
		setLabelSaving(labelId);
		try {
			const label = await api.request.updateLabel({ projectId, labelId, name, color });
			const updated: Project = {
				...project,
				labels: (project.labels ?? []).map((l) => (l.id === labelId ? label : l)),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("labels.failedUpdate", { error: String(err) }));
		}
		setLabelSaving(null);
	}

	async function handleDeleteLabel(labelId: string) {
		if (!project) return;
		setLabelSaving(labelId);
		try {
			await api.request.deleteLabel({ projectId, labelId });
			const updated: Project = {
				...project,
				labels: (project.labels ?? []).filter((l) => l.id !== labelId),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("labels.failedDelete", { error: String(err) }));
		}
		setLabelSaving(null);
	}

	async function handleAddColumn() {
		if (!project) return;
		setColumnSaving("new");
		try {
			const column = await api.request.createCustomColumn({ projectId, name: "New Column" });
			const updated: Project = { ...project, customColumns: [...(project.customColumns ?? []), column] };
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("customColumns.failedCreate", { error: String(err) }));
		}
		setColumnSaving(null);
	}

	async function handleUpdateColumn(columnId: string, name: string, color: string, llmInstruction: string, agentConfig?: ColumnAgentConfig | null) {
		if (!project) return;
		setColumnSaving(columnId);
		try {
			const column = await api.request.updateCustomColumn({ projectId, columnId, name, color, llmInstruction, agentConfig });
			const updated: Project = {
				...project,
				customColumns: (project.customColumns ?? []).map((c) => (c.id === columnId ? column : c)),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("customColumns.failedUpdate", { error: String(err) }));
		}
		setColumnSaving(null);
	}

	async function handleDeleteColumn(columnId: string) {
		if (!project) return;
		setColumnSaving(columnId);
		try {
			await api.request.deleteCustomColumn({ projectId, columnId });
			const updated: Project = {
				...project,
				customColumns: (project.customColumns ?? []).filter((c) => c.id !== columnId),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			alert(t("customColumns.failedDelete", { error: String(err) }));
		}
		setColumnSaving(null);
	}

	async function handleSaveRepo() {
		setSavingRepo(true);
		try {
			const builtinColumnAgents: Record<string, ColumnAgentConfig> | undefined = aiReviewEnabled
				? {
					"review-by-ai": {
						agentId: aiReviewAgentId,
						configId: aiReviewConfigId,
						prompt: aiReviewPrompt.trim() === DEFAULT_REVIEW_PROMPT ? "" : aiReviewPrompt.trim(),
					},
				}
				: undefined;
			const toSave = {
				...repoConfig,
				clonePaths: (repoConfig.clonePaths ?? []).filter((p) => p.trim() !== ""),
				sparseCheckoutPaths: (repoConfig.sparseCheckoutPaths ?? []).filter((p) => p.trim() !== ""),
				builtinColumnAgents,
			};
			await api.request.saveRepoConfig({ projectId, ...toSave });
			loadedRepoConfig.current = toSave;
			// Refresh projects to pick up new resolved settings
			const updatedProjects = await api.request.getProjects();
			for (const p of updatedProjects) dispatch({ type: "updateProject", project: p });
		} catch (err) {
			alert(t("projectSettings.failedSave", { error: String(err) }));
		}
		setSavingRepo(false);
	}

	async function handleSaveLocal() {
		setSavingLocal(true);
		try {
			const toSave = {
				...localConfig,
				clonePaths: (localConfig.clonePaths ?? []).filter((p) => p.trim() !== ""),
				sparseCheckoutPaths: (localConfig.sparseCheckoutPaths ?? []).filter((p) => p.trim() !== ""),
			};
			await api.request.saveLocalConfig({ projectId, ...toSave });
			loadedLocalConfig.current = toSave;
			// Refresh projects to pick up new resolved settings
			const updatedProjects = await api.request.getProjects();
			for (const p of updatedProjects) dispatch({ type: "updateProject", project: p });
		} catch (err) {
			alert(t("projectSettings.failedSave", { error: String(err) }));
		}
		setSavingLocal(false);
	}

	// Keep the ref in sync for the navigation guard
	handleSaveRef.current = async () => {
		if (activeTab === "repo") await handleSaveRepo();
		else await handleSaveLocal();
	};

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-2xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6 space-y-7">

					{/* Config tabs */}
					<div>
						<div className="flex gap-1 bg-elevated/50 rounded-xl p-1 mb-1">
							<button
								type="button"
								onClick={() => setActiveTab("repo")}
								className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
									activeTab === "repo"
										? "bg-accent text-white shadow-sm"
										: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
								}`}
							>
								{t("projectSettings.tabRepo")}
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("local")}
								className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
									activeTab === "local"
										? "bg-accent text-white shadow-sm"
										: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
								}`}
							>
								{t("projectSettings.tabLocal")}
							</button>
						</div>
						<p className="text-fg-muted text-xs px-1">
							{activeTab === "repo"
								? t("projectSettings.tabRepoDesc")
								: t("projectSettings.tabLocalDesc")}
						</p>
					</div>

					{/* Config form for active tab */}
					{activeTab === "repo" ? (
						<ConfigForm
							config={repoConfig}
							onChange={setRepoConfig}
							saving={savingRepo}
							onSave={handleSaveRepo}
							saveLabel={t("projectSettings.saveRepo")}
							savingLabel={t("projectSettings.saving")}
							projectId={projectId}
							projectPath={project.path}
						/>
					) : (
						<ConfigForm
							config={localConfig}
							onChange={setLocalConfig}
							inherited={repoConfig}
							saving={savingLocal}
							onSave={handleSaveLocal}
							saveLabel={t("projectSettings.saveLocal")}
							savingLabel={t("projectSettings.saving")}
							projectId={projectId}
							projectPath={project.path}
						/>
					)}

					{/* AI Review */}
					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<div>
								<label className="block text-fg text-sm font-semibold mb-1">
									{t("projectSettings.aiReview")}
								</label>
								<p className="text-fg-3 text-sm">
									{t("projectSettings.aiReviewDesc")}
								</p>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={aiReviewEnabled}
								aria-label={t("projectSettings.aiReviewEnabled")}
								onClick={() => setAiReviewEnabled((v) => !v)}
								className={`relative flex-shrink-0 ml-4 w-10 h-6 rounded-full transition-colors focus:outline-none ${
									aiReviewEnabled ? "bg-accent" : "bg-edge-active"
								}`}
							>
								<span
									className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
										aiReviewEnabled ? "translate-x-4" : "translate-x-0"
									}`}
								/>
							</button>
						</div>
						{aiReviewEnabled && (
							<div className="space-y-3 pl-1">
								{/* Agent selector */}
								<div className="flex items-center gap-3">
									<label className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewAgent")}</label>
									<select
										value={aiReviewAgentId}
										onChange={(e) => {
											setAiReviewAgentId(e.target.value);
											const agent = availableAgents.find((a) => a.id === e.target.value);
											if (agent?.configurations?.length) {
												setAiReviewConfigId(agent.configurations[0].id);
											}
										}}
										className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
									>
										{availableAgents.map((a) => (
											<option key={a.id} value={a.id}>{a.name}</option>
										))}
									</select>
								</div>
								{/* Config selector */}
								<div className="flex items-center gap-3">
									<label className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewConfig")}</label>
									<select
										value={aiReviewConfigId}
										onChange={(e) => setAiReviewConfigId(e.target.value)}
										className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
									>
										{(availableAgents.find((a) => a.id === aiReviewAgentId)?.configurations ?? []).map((c) => (
											<option key={c.id} value={c.id}>{c.name || c.id}</option>
										))}
									</select>
								</div>
								{/* Review prompt */}
								<div>
									<label className="block text-fg-2 text-sm mb-2">{t("projectSettings.aiReviewPrompt")}</label>
									<textarea
										value={aiReviewPrompt}
										onChange={(e) => setAiReviewPrompt(e.target.value)}
										rows={5}
										placeholder={t("projectSettings.aiReviewPromptPlaceholder")}
										autoCapitalize="off"
										autoCorrect="off"
										spellCheck={false}
										className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
									/>
								</div>
							</div>
						)}
					</div>

					{/* Custom Columns */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("customColumns.settingsTitle")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("customColumns.settingsDesc")}
						</p>
						<div className="space-y-2">
							{(project.customColumns ?? []).map((col: CustomColumn) => (
								<CustomColumnRow
									key={col.id}
									column={col}
									saving={columnSaving === col.id}
									onUpdate={(name, color, llmInstruction, agentConfig) => handleUpdateColumn(col.id, name, color, llmInstruction, agentConfig)}
									onDelete={() => handleDeleteColumn(col.id)}
									availableAgents={availableAgents}
								/>
							))}
							{(project.customColumns ?? []).length === 0 && (
								<p className="text-fg-muted text-sm italic">{t("customColumns.noColumns")}</p>
							)}
						</div>
						<button
							type="button"
							onClick={handleAddColumn}
							disabled={columnSaving !== null}
							className="mt-3 text-sm text-accent hover:text-accent-hover font-medium transition-colors disabled:opacity-50"
						>
							{t("customColumns.addColumn")}
						</button>
					</div>

					{/* Labels */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("labels.settingsTitle")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("labels.settingsDesc")}
						</p>
						<div className="space-y-2">
							{(project.labels ?? []).map((label: Label) => (
								<LabelRow
									key={label.id}
									label={label}
									saving={labelSaving === label.id}
									onUpdate={(name, color) => handleUpdateLabel(label.id, name, color)}
									onDelete={() => handleDeleteLabel(label.id)}
									nameLabel={t("labels.labelName")}
									deleteLabel={t("labels.deleteLabel")}
								/>
							))}
							{(project.labels ?? []).length === 0 && (
								<p className="text-fg-muted text-sm italic">{t("labels.noLabels")}</p>
							)}
						</div>
						<button
							type="button"
							onClick={handleAddLabel}
							disabled={labelSaving !== null}
							className="mt-3 text-sm text-accent hover:text-accent-hover font-medium transition-colors disabled:opacity-50"
						>
							{t("labels.addLabel")}
						</button>
					</div>

				</div>
			</div>
		</div>
	);
}

export default ProjectSettings;
