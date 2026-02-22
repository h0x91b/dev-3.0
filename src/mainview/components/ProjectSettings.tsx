import { useState, useEffect, type Dispatch } from "react";
import type { Project, CodingAgent } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

const CUSTOM_COMMAND_VALUE = "__custom__";

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
	const [defaultTmuxCommand, setDefaultTmuxCommand] = useState(
		project?.defaultTmuxCommand || "claude",
	);
	const [defaultBaseBranch, setDefaultBaseBranch] = useState(
		project?.defaultBaseBranch || "main",
	);
	const [saving, setSaving] = useState(false);

	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [selectedAgentId, setSelectedAgentId] = useState<string>(
		project?.defaultAgentId || CUSTOM_COMMAND_VALUE,
	);

	useEffect(() => {
		api.request.getAgents().then((all) => {
			setAgents(all);

			// Auto-detect: if no defaultAgentId but defaultTmuxCommand matches a builtin
			if (!project?.defaultAgentId && project?.defaultTmuxCommand) {
				const cmd = project.defaultTmuxCommand.trim().toLowerCase();
				const match = all.find(
					(a) => a.kind !== "custom" && a.kind === cmd,
				);
				if (match) {
					setSelectedAgentId(match.id);
				} else {
					setSelectedAgentId(CUSTOM_COMMAND_VALUE);
				}
			}
		});
	}, [project?.defaultAgentId, project?.defaultTmuxCommand]);

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
			const agentId =
				selectedAgentId === CUSTOM_COMMAND_VALUE ? null : selectedAgentId;
			const updated = await api.request.updateProjectSettings({
				projectId,
				setupScript,
				defaultTmuxCommand,
				defaultAgentId: agentId,
				defaultBaseBranch,
			});
			dispatch({ type: "updateProject", project: updated });
			navigate({ screen: "project", projectId });
		} catch (err) {
			alert(t("projectSettings.failedSave", { error: String(err) }));
		}
		setSaving(false);
	}

	const isCustomCommand = selectedAgentId === CUSTOM_COMMAND_VALUE;

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-xl space-y-7">
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

					{/* Coding Agent */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("projectSettings.agent")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("projectSettings.agentDesc")}
						</p>
						<select
							value={selectedAgentId}
							onChange={(e) => setSelectedAgentId(e.target.value)}
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
						>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name}
									{agent.kind === "custom" && agent.command
										? ` — ${agent.command}`
										: ""}
								</option>
							))}
							<option value={CUSTOM_COMMAND_VALUE}>
								{t("projectSettings.customCommand")}...
							</option>
						</select>
					</div>

					{/* Custom Command (only visible when "Custom command..." selected) */}
					{isCustomCommand && (
						<div>
							<label className="block text-fg text-sm font-semibold mb-2">
								{t("projectSettings.defaultCommand")}
							</label>
							<p className="text-fg-3 text-sm mb-3">
								{t("projectSettings.defaultCommandDesc")}
							</p>
							<input
								type="text"
								value={defaultTmuxCommand}
								onChange={(e) => setDefaultTmuxCommand(e.target.value)}
								placeholder="claude"
								className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
							/>
						</div>
					)}

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
