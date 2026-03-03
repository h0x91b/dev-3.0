import { useState, type Dispatch } from "react";
import type { Label, Project } from "../../shared/types";
import { LABEL_COLORS } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

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

interface ProjectSettingsProps {
	projectId: string;
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function ProjectSettings({
	projectId,
	projects,
	dispatch,
	navigate,
}: ProjectSettingsProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	const [setupScript, setSetupScript] = useState(project?.setupScript || "");
	const [devScript, setDevScript] = useState(project?.devScript || "");
	const [cleanupScript, setCleanupScript] = useState(project?.cleanupScript || "");
	const [defaultBaseBranch, setDefaultBaseBranch] = useState(
		project?.defaultBaseBranch || "main",
	);
	const [clonePaths, setClonePaths] = useState<string[]>(project?.clonePaths || []);
	const [newClonePath, setNewClonePath] = useState("");
	const [saving, setSaving] = useState(false);
	const [labelSaving, setLabelSaving] = useState<string | null>(null);

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

	async function handleSave() {
		setSaving(true);
		try {
			const updated = await api.request.updateProjectSettings({
				projectId,
				setupScript,
				devScript,
				cleanupScript,
				defaultBaseBranch,
				clonePaths,
			});
			dispatch({ type: "updateProject", project: updated });
			navigate({ screen: "project", projectId });
		} catch (err) {
			alert(t("projectSettings.failedSave", { error: String(err) }));
		}
		setSaving(false);
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-2xl mx-auto space-y-7">
					{/* Setup Script */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.setupScript")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("projectSettings.setupScriptDesc")}
						</p>
						<textarea
							value={setupScript}
							onChange={(e) => setSetupScript(e.target.value)}
							rows={4}
							placeholder="bun install"
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
					</div>

					{/* Clone Paths */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.clonePaths")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("projectSettings.clonePathsDesc")}
						</p>
						<div className="space-y-2">
							{clonePaths.map((path, idx) => (
								<div key={idx} className="flex items-center gap-2 p-2.5 bg-raised rounded-xl border border-edge">
									<span className="flex-1 text-fg text-sm font-mono truncate">{path}</span>
									<button
										type="button"
										onClick={() => setClonePaths(clonePaths.filter((_, i) => i !== idx))}
										className="w-6 h-6 flex items-center justify-center rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0"
										title={t("projectSettings.clonePathRemove")}
									>
										<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>
							))}
							{clonePaths.length === 0 && (
								<p className="text-fg-muted text-sm italic">{t("projectSettings.noClonePaths")}</p>
							)}
						</div>
						<div className="flex items-center gap-2 mt-3">
							<input
								type="text"
								value={newClonePath}
								onChange={(e) => setNewClonePath(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && newClonePath.trim()) {
										setClonePaths([...clonePaths, newClonePath.trim()]);
										setNewClonePath("");
									}
								}}
								placeholder="node_modules"
								className="flex-1 px-3 py-2 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
							/>
							<button
								type="button"
								onClick={() => {
									if (newClonePath.trim()) {
										setClonePaths([...clonePaths, newClonePath.trim()]);
										setNewClonePath("");
									}
								}}
								className="text-sm text-accent hover:text-accent-hover font-medium transition-colors"
							>
								{t("projectSettings.addClonePath")}
							</button>
						</div>
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
						value={devScript}
						onChange={(e) => setDevScript(e.target.value)}
						rows={4}
						placeholder="bun run dev"
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
						value={cleanupScript}
						onChange={(e) => setCleanupScript(e.target.value)}
						rows={4}
						placeholder="git worktree remove ."
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
							value={defaultBaseBranch}
							onChange={(e) => setDefaultBaseBranch(e.target.value)}
							placeholder="main"
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
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

					{/* Save Button */}
					<button
						onClick={handleSave}
						disabled={saving}
						className="px-6 py-2.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover disabled:opacity-50 shadow-lg shadow-accent/20 transition-all active:scale-95"
					>
						{saving ? t("projectSettings.saving") : t("projectSettings.save")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ProjectSettings;
