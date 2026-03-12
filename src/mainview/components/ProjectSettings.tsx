import { useState, useEffect, useRef, useCallback, type Dispatch, type MutableRefObject } from "react";
import type { ConfigSourceEntry, CustomColumn, Label, Project } from "../../shared/types";
import { CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS, LABEL_COLORS } from "../../shared/types";
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
	onUpdate: (name: string, color: string, llmInstruction: string) => void;
	onDelete: () => void;
}

function CustomColumnRow({ column, saving, onUpdate, onDelete }: CustomColumnRowProps) {
	const t = useT();
	const [name, setName] = useState(column.name);
	const [color, setColor] = useState(column.color);
	const [llmInstruction, setLlmInstruction] = useState(column.llmInstruction);

	function commitUpdate(newName = name, newColor = color, newInstruction = llmInstruction) {
		const trimmedName = newName.trim();
		if (
			trimmedName &&
			(trimmedName !== column.name || newColor !== column.color || newInstruction !== column.llmInstruction)
		) {
			onUpdate(trimmedName, newColor, newInstruction);
		}
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
		</div>
	);
}

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
	navigate,
	navigationGuardRef,
}: ProjectSettingsProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	const [setupScript, setSetupScript] = useState(project?.setupScript || "");
	const [devScript, setDevScript] = useState(project?.devScript || "");
	const [cleanupScript, setCleanupScript] = useState(project?.cleanupScript || "");
	const [clonePaths, setClonePaths] = useState<string[]>(project?.clonePaths || []);
	const [defaultBaseBranch, setDefaultBaseBranch] = useState(
		project?.defaultBaseBranch || "main",
	);
	const [peerReviewEnabled, setPeerReviewEnabled] = useState(project?.peerReviewEnabled !== false);
	const [sparseCheckoutEnabled, setSparseCheckoutEnabled] = useState(project?.sparseCheckoutEnabled ?? false);
	const [sparseCheckoutPaths, setSparseCheckoutPaths] = useState<string[]>(project?.sparseCheckoutPaths ?? []);
	const [saving, setSaving] = useState(false);
	const [savingToRepo, setSavingToRepo] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [exportFeedback, setExportFeedback] = useState<string | null>(null);
	const [configSources, setConfigSources] = useState<Record<string, string>>({});
	const [labelSaving, setLabelSaving] = useState<string | null>(null);
	const [columnSaving, setColumnSaving] = useState<string | null>(null);
	const [detecting, setDetecting] = useState(false);
	const [detectFeedback, setDetectFeedback] = useState<string | null>(null);
	const autoDetectRan = useRef(false);
	const configSourcesLoaded = useRef(false);

	// Load config sources on mount
	useEffect(() => {
		if (!configSourcesLoaded.current && project) {
			configSourcesLoaded.current = true;
			api.request.getRepoConfigSources({ projectId }).then((sources: ConfigSourceEntry[]) => {
				const map: Record<string, string> = {};
				for (const s of sources) map[s.field] = s.source;
				setConfigSources(map);
			}).catch(() => {});
		}
	}, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const arraysEqual = (a: string[], b: string[]) =>
		a.length === b.length && a.every((v, i) => v === b[i]);

	const isDirty = useCallback(() => {
		if (!project) return false;
		return (
			setupScript !== (project.setupScript || "") ||
			devScript !== (project.devScript || "") ||
			cleanupScript !== (project.cleanupScript || "") ||
			defaultBaseBranch !== (project.defaultBaseBranch || "main") ||
			peerReviewEnabled !== (project.peerReviewEnabled !== false) ||
			sparseCheckoutEnabled !== (project.sparseCheckoutEnabled ?? false) ||
			!arraysEqual(clonePaths, project.clonePaths || []) ||
			!arraysEqual(sparseCheckoutPaths, project.sparseCheckoutPaths ?? [])
		);
	}, [project, setupScript, devScript, cleanupScript, defaultBaseBranch, peerReviewEnabled, sparseCheckoutEnabled, clonePaths, sparseCheckoutPaths]);

	// Use a ref so the navigation guard always calls the latest handleSave
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

	async function runAutoDetect() {
		if (!project) return;
		setDetecting(true);
		setDetectFeedback(null);
		try {
			const detected = await api.request.detectClonePaths({ projectId });
			if (detected.length > 0) {
				// Merge with existing paths (no duplicates)
				const existing = new Set(clonePaths);
				const merged = [...clonePaths, ...detected.filter((p) => !existing.has(p))];
				setClonePaths(merged);
				setDetectFeedback(t.plural("projectSettings.autoDetectFound", detected.length));
			} else {
				setDetectFeedback(t("projectSettings.autoDetectNone"));
			}
		} catch {
			setDetectFeedback(t("projectSettings.autoDetectNone"));
		}
		setDetecting(false);
	}

	// Auto-run detect when clone paths are empty (e.g. project added before this feature)
	useEffect(() => {
		if (!autoDetectRan.current && project && clonePaths.length === 0) {
			autoDetectRan.current = true;
			runAutoDetect();
		}
	}, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

	async function handleUpdateColumn(columnId: string, name: string, color: string, llmInstruction: string) {
		if (!project) return;
		setColumnSaving(columnId);
		try {
			const column = await api.request.updateCustomColumn({ projectId, columnId, name, color, llmInstruction });
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

	async function doSave(andNavigate = true) {
		setSaving(true);
		try {
			const updated = await api.request.updateProjectSettings({
				projectId,
				setupScript,
				devScript,
				cleanupScript,
				defaultBaseBranch,
				clonePaths: clonePaths.filter((p) => p.trim() !== ""),
				peerReviewEnabled,
				sparseCheckoutEnabled,
				sparseCheckoutPaths: sparseCheckoutPaths.filter((p) => p.trim() !== ""),
			});
			dispatch({ type: "updateProject", project: updated });
			if (andNavigate) navigate({ screen: "project", projectId });
		} catch (err) {
			alert(t("projectSettings.failedSave", { error: String(err) }));
		}
		setSaving(false);
	}

	// Keep the ref in sync for the navigation guard
	handleSaveRef.current = () => doSave(false);

	function handleSave() {
		doSave(true);
	}

	const dirty = isDirty();

	async function handleSaveToRepo() {
		setSavingToRepo(true);
		try {
			await api.request.saveRepoConfig({
				projectId,
				setupScript,
				devScript,
				cleanupScript,
				defaultBaseBranch,
				clonePaths: clonePaths.filter((p) => p.trim() !== ""),
				peerReviewEnabled,
			});
			// Refresh sources
			const sources = await api.request.getRepoConfigSources({ projectId });
			const map: Record<string, string> = {};
			for (const s of sources) map[s.field] = s.source;
			setConfigSources(map);
		} catch (err) {
			alert(t("projectSettings.failedSaveToRepo", { error: String(err) }));
		}
		setSavingToRepo(false);
	}

	async function handleExportToRepo() {
		setExporting(true);
		setExportFeedback(null);
		try {
			await api.request.exportRepoConfig({ projectId });
			setExportFeedback(t("projectSettings.exportSuccess"));
			// Refresh sources
			const sources = await api.request.getRepoConfigSources({ projectId });
			const map: Record<string, string> = {};
			for (const s of sources) map[s.field] = s.source;
			setConfigSources(map);
		} catch (err) {
			alert(t("projectSettings.failedExport", { error: String(err) }));
		}
		setExporting(false);
	}

	function sourceBadge(field: string) {
		const source = configSources[field];
		if (!source || source === "global") return null;
		const label = source === "repo" ? t("projectSettings.sourceRepo") : t("projectSettings.sourceLocal");
		const color = source === "repo" ? "text-accent bg-accent/10" : "text-fg-3 bg-elevated";
		return (
			<span className={`ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded ${color}`}>
				{label}
			</span>
		);
	}

	return (
		<div className="h-full w-full flex flex-col">
			{dirty && (
				<div className="flex-shrink-0 px-7 py-2 bg-accent/10 border-b border-accent/20 flex items-center justify-between">
					<span className="text-fg-2 text-sm">{t("unsavedChanges.banner")}</span>
					<button
						onClick={handleSave}
						disabled={saving}
						className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-all active:scale-95"
					>
						{saving ? t("projectSettings.saving") : t("projectSettings.save")}
					</button>
				</div>
			)}
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-2xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6 space-y-7">
					{/* Setup Script */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.setupScript")}{sourceBadge("setupScript")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("projectSettings.setupScriptDesc")}
						</p>
						<textarea
							value={setupScript}
							onChange={(e) => setSetupScript(e.target.value)}
							rows={4}
							placeholder="bun install"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
					</div>

					{/* Clone Paths (CoW) */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.clonePaths")}{sourceBadge("clonePaths")}
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
							items={clonePaths}
							onChange={(items) => {
								setClonePaths(items);
								setDetectFeedback(null);
							}}
							placeholder="node_modules"
							addLabel={t("projectSettings.addClonePath")}
						/>
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
							{sparseCheckoutEnabled && project && (
								<button
									type="button"
									onClick={() => api.request.openFolder({ path: project.path })}
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
								aria-checked={!sparseCheckoutEnabled}
								aria-label={t("projectSettings.sparseCheckoutAll")}
								onClick={() => {
									setSparseCheckoutEnabled((v) => {
										const next = !v;
										if (next && sparseCheckoutPaths.length === 0) {
											setSparseCheckoutPaths([""]);
										}
										return next;
									});
								}}
								className={`relative flex-shrink-0 ml-4 w-10 h-6 rounded-full transition-colors focus:outline-none ${
									!sparseCheckoutEnabled ? "bg-accent" : "bg-edge-active"
								}`}
							>
								<span
									className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
										!sparseCheckoutEnabled ? "translate-x-4" : "translate-x-0"
									}`}
								/>
							</button>
						</div>
						{sparseCheckoutEnabled && (
							<ListEditor
								items={sparseCheckoutPaths}
								onChange={setSparseCheckoutPaths}
								placeholder={t("projectSettings.sparseCheckoutPlaceholder")}
								addLabel={t("projectSettings.sparseCheckoutAddPath")}
							/>
						)}
					</div>

					{/* Dev Script */}
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("projectSettings.devScript")}{sourceBadge("devScript")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("projectSettings.devScriptDesc")}
					</p>
					<textarea
						value={devScript}
						onChange={(e) => setDevScript(e.target.value)}
						rows={4}
						placeholder="bun run dev"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
					/>
				</div>

				{/* Cleanup Script */}
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("projectSettings.cleanupScript")}{sourceBadge("cleanupScript")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("projectSettings.cleanupScriptDesc")}
					</p>
					<textarea
						value={cleanupScript}
						onChange={(e) => setCleanupScript(e.target.value)}
						rows={4}
						placeholder="git worktree remove ."
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
					/>
				</div>

				{/* Default Base Branch */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.baseBranch")}{sourceBadge("defaultBaseBranch")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("projectSettings.baseBranchDesc")}
						</p>
						<input
							type="text"
							value={defaultBaseBranch}
							onChange={(e) => setDefaultBaseBranch(e.target.value)}
							placeholder="main"
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
									{t("projectSettings.peerReview")}{sourceBadge("peerReviewEnabled")}
								</label>
								<p className="text-fg-3 text-sm">
									{t("projectSettings.peerReviewDesc")}
								</p>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={peerReviewEnabled}
								aria-label={t("projectSettings.peerReview")}
								onClick={() => setPeerReviewEnabled((v) => !v)}
								className={`relative flex-shrink-0 ml-4 w-10 h-6 rounded-full transition-colors focus:outline-none ${
									peerReviewEnabled ? "bg-accent" : "bg-edge-active"
								}`}
							>
								<span
									className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
										peerReviewEnabled ? "translate-x-4" : "translate-x-0"
									}`}
								/>
							</button>
						</div>
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
									onUpdate={(name, color, llmInstruction) => handleUpdateColumn(col.id, name, color, llmInstruction)}
									onDelete={() => handleDeleteColumn(col.id)}
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

					{/* Save Buttons */}
					<div className="flex items-center gap-3 flex-wrap">
						<button
							onClick={handleSave}
							disabled={saving}
							className="px-6 py-2.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover disabled:opacity-50 shadow-lg shadow-accent/20 transition-all active:scale-95"
						>
							{saving ? t("projectSettings.saving") : t("projectSettings.save")}
						</button>
						<button
							onClick={handleSaveToRepo}
							disabled={savingToRepo}
							className="px-5 py-2.5 bg-raised border border-accent/30 text-accent text-sm font-semibold rounded-xl hover:bg-accent/10 hover:border-accent/50 disabled:opacity-50 transition-all active:scale-95"
						>
							{savingToRepo ? t("projectSettings.savingToRepo") : t("projectSettings.saveToRepo")}
						</button>
						<button
							onClick={handleExportToRepo}
							disabled={exporting}
							className="px-5 py-2.5 bg-raised border border-edge text-fg-2 text-sm font-medium rounded-xl hover:bg-elevated hover:border-edge-active disabled:opacity-50 transition-all active:scale-95"
						>
							{exporting ? t("projectSettings.exporting") : t("projectSettings.exportToRepo")}
						</button>
					</div>
					{exportFeedback && (
						<p className="text-accent text-sm">{exportFeedback}</p>
					)}
				</div>
			</div>
		</div>
	);
}

export default ProjectSettings;
