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
			<div className="h-screen w-screen flex items-center justify-center bg-[#1a1b26]">
				<span className="text-[#f7768e]">Project not found</span>
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
		<div className="h-screen w-screen flex flex-col bg-[#1a1b26]">
			{/* Header */}
			<div className="flex items-center gap-4 px-6 py-3 bg-[#16161e] border-b border-[#292e42]">
				<button
					onClick={() => navigate({ screen: "project", projectId })}
					className="text-[#565f89] hover:text-[#c0caf5] text-sm transition-colors"
				>
					&larr; Back
				</button>
				<span className="text-[#c0caf5] font-bold text-lg">
					{project.name} — Settings
				</span>
			</div>

			{/* Form */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-xl space-y-6">
					{/* Setup Script */}
					<div>
						<label className="block text-[#a9b1d6] text-sm mb-2">
							Setup Script
						</label>
						<p className="text-[#565f89] text-xs mb-2">
							Runs in the worktree directory after creation (e.g., install
							dependencies)
						</p>
						<textarea
							value={setupScript}
							onChange={(e) => setSetupScript(e.target.value)}
							rows={5}
							placeholder="#!/bin/bash&#10;bun install"
							className="w-full px-3 py-2 bg-[#16161e] border border-[#292e42] rounded text-[#c0caf5] text-sm font-mono placeholder-[#565f89] outline-none focus:border-[#7aa2f7] resize-y"
						/>
					</div>

					{/* Default Tmux Command */}
					<div>
						<label className="block text-[#a9b1d6] text-sm mb-2">
							Default Tmux Command
						</label>
						<p className="text-[#565f89] text-xs mb-2">
							Command to run inside tmux for new tasks
						</p>
						<input
							type="text"
							value={defaultTmuxCommand}
							onChange={(e) => setDefaultTmuxCommand(e.target.value)}
							placeholder="claude"
							className="w-full px-3 py-2 bg-[#16161e] border border-[#292e42] rounded text-[#c0caf5] text-sm placeholder-[#565f89] outline-none focus:border-[#7aa2f7]"
						/>
					</div>

					{/* Default Base Branch */}
					<div>
						<label className="block text-[#a9b1d6] text-sm mb-2">
							Default Base Branch
						</label>
						<p className="text-[#565f89] text-xs mb-2">
							Branch to create worktrees from
						</p>
						<input
							type="text"
							value={defaultBaseBranch}
							onChange={(e) => setDefaultBaseBranch(e.target.value)}
							placeholder="main"
							className="w-full px-3 py-2 bg-[#16161e] border border-[#292e42] rounded text-[#c0caf5] text-sm placeholder-[#565f89] outline-none focus:border-[#7aa2f7]"
						/>
					</div>

					{/* Save Button */}
					<button
						onClick={handleSave}
						disabled={saving}
						className="px-6 py-2 bg-[#7aa2f7] text-[#1a1b26] text-sm font-medium rounded hover:bg-[#89b4fa] disabled:opacity-50 transition-colors"
					>
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ProjectSettings;
