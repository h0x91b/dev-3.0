import { useState } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { isBuiltinOpsProject, type Project, type Space } from "../../shared/types";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";

interface SpaceProjectsModalProps {
	space: Space;
	projects: Project[];
	onClose: () => void;
	/** Hand off to the Add Project flow, pre-linked to this space. */
	onCreateProject?: (space: Space) => void;
}

/**
 * Edits which projects belong to one space — the space's `Edit` action.
 *
 * It lists every project with the members already ticked, so the same screen
 * adds and removes. An add-only dialog left removal reachable solely from the
 * project row's own `Spaces…` picker, which is the wrong place to look when the
 * question is "what is in this space".
 */
function SpaceProjectsModal({ space, projects, onClose, onCreateProject }: SpaceProjectsModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [saving, setSaving] = useState(false);
	const [query, setQuery] = useState("");

	useEscapeKey(onClose);

	const candidates = projects.filter((p) => !p.deleted && !isBuiltinOpsProject(p));
	// Seeded from the space, then owned by the dialog: a tick is a pending edit,
	// not a write, so nothing changes until Save.
	const [checked, setChecked] = useState<Set<string>>(
		() => new Set(candidates.filter((p) => space.projectIds.includes(p.id)).map((p) => p.id)),
	);

	const q = query.trim().toLowerCase();
	// Match on name and path — a project is often recognised by where it lives.
	const shown = q ? candidates.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(q)) : candidates;

	const member = new Set(candidates.filter((p) => space.projectIds.includes(p.id)).map((p) => p.id));
	const added = [...checked].filter((id) => !member.has(id));
	const removed = [...member].filter((id) => !checked.has(id));
	const dirty = added.length + removed.length > 0;

	function toggle(projectId: string) {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}

	async function handleSave() {
		if (!dirty || saving) return;
		setSaving(true);
		try {
			// Membership is keyed by project, so each changed project is its own
			// write — re-read the spaces file per project to keep its other spaces.
			for (const projectId of [...added, ...removed]) {
				const current = await api.request.getSpaces({});
				const own = current.spaces
					.filter((s) => !s.deleted && s.projectIds.includes(projectId))
					.map((s) => s.id);
				const next = added.includes(projectId)
					? [...new Set([...own, space.id])]
					: own.filter((id) => id !== space.id);
				await api.request.setProjectSpaces({ projectId, spaceIds: next });
			}
			onClose();
		} catch (err) {
			toast.error(t("spaces.failedUpdate", { error: String(err) }));
			setSaving(false);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="space-projects-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26rem] p-6 space-y-4 outline-none"
			>
				<div className="space-y-1">
					<h2 id="space-projects-title" className="text-fg text-lg font-semibold">
						{t("spaces.editProjectsTitle", { name: space.name })}
					</h2>
					<p className="text-fg-3 text-xs">{t("spaces.editProjectsHint")}</p>
				</div>

				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("spaces.addProjectsSearch")}
					autoFocus
					className="w-full bg-elevated border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
					data-testid="space-projects-search"
				/>

				<div className="max-h-56 overflow-y-auto rounded-lg border border-edge divide-y divide-edge/40">
					{shown.map((project) => (
						<label
							key={project.id}
							className="flex items-center gap-2.5 px-3 py-2 hover:bg-elevated-hover transition-colors cursor-pointer"
						>
							<input
								type="checkbox"
								checked={checked.has(project.id)}
								onChange={() => toggle(project.id)}
								className="w-3.5 h-3.5 rounded accent-accent"
								data-testid={`space-projects-${project.id}`}
							/>
							<span className="text-xs text-fg truncate">{project.name}</span>
						</label>
					))}
					{shown.length === 0 && (
						<div className="px-3 py-4 text-xs text-fg-muted text-center">
							{q ? t("spaces.noProjectsMatch") : t("spaces.editProjectsEmpty")}
						</div>
					)}
				</div>

				<div className="flex items-center gap-2">
					{onCreateProject && (
						<button
							type="button"
							onClick={() => onCreateProject(space)}
							className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 text-sm rounded-lg text-accent hover:bg-elevated transition-colors"
							data-testid="space-projects-new-project"
						>
							<svg aria-hidden="true" focusable="false" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
							</svg>
							{t("spaces.addProjectsNewProject")}
						</button>
					)}
					<span className="flex-1" />
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("spaces.cancel")}
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={!dirty || saving}
						className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						data-testid="space-projects-save"
					>
						{t("spaces.editProjectsSubmit")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default SpaceProjectsModal;
