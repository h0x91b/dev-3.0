import { useState, type Dispatch } from "react";
import type { Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

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
	const [saving, setSaving] = useState(false);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
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
