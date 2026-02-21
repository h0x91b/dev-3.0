import { useState, type Dispatch } from "react";
import type { Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";

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
	const project = projects.find((p) => p.id === projectId);

	const [setupScript, setSetupScript] = useState(project?.setupScript || "");
	const [defaultTmuxCommand, setDefaultTmuxCommand] = useState(
		project?.defaultTmuxCommand || "claude",
	);
	const [defaultBaseBranch, setDefaultBaseBranch] = useState(
		project?.defaultBaseBranch || "main",
	);
	const [saving, setSaving] = useState(false);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<span className="text-danger text-base">Project not found</span>
			</div>
		);
	}

	async function handleSave() {
		setSaving(true);
		try {
			const updated = await api.request.updateProjectSettings({
				projectId,
				setupScript,
				defaultTmuxCommand,
				defaultBaseBranch,
			});
			dispatch({ type: "updateProject", project: updated });
			navigate({ screen: "project", projectId });
		} catch (err) {
			alert(`Failed to save settings: ${err}`);
		}
		setSaving(false);
	}

	return (
		<div className="h-full w-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center gap-4 px-6 py-4 border-b border-edge">
				<button
					onClick={() => navigate({ screen: "project", projectId })}
					className="text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated"
				>
					<svg
						className="w-5 h-5"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
				<span className="text-fg font-bold text-lg">
					Settings
				</span>
				<span className="text-fg-3 text-sm">{project.name}</span>
			</div>

			{/* Form */}
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-xl space-y-7">
					{/* Setup Script */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							Setup Script
						</label>
						<p className="text-fg-3 text-sm mb-3">
							Runs in the worktree directory after creation
						</p>
						<textarea
							value={setupScript}
							onChange={(e) => setSetupScript(e.target.value)}
							rows={4}
							placeholder="bun install"
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
					</div>

					{/* Default Tmux Command */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							Default Command
						</label>
						<p className="text-fg-3 text-sm mb-3">
							Command to run inside tmux for new tasks
						</p>
						<input
							type="text"
							value={defaultTmuxCommand}
							onChange={(e) => setDefaultTmuxCommand(e.target.value)}
							placeholder="claude"
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					{/* Default Base Branch */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							Base Branch
						</label>
						<p className="text-fg-3 text-sm mb-3">
							Branch to create worktrees from
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
						{saving ? "Saving..." : "Save Settings"}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ProjectSettings;
