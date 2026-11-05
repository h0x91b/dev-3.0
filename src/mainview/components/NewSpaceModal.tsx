import { useState } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { orderProjectsForDisplay, isBuiltinOpsProject, type Project } from "../../shared/types";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";

interface NewSpaceModalProps {
	projects: Project[];
	initialProjectIds?: string[];
	onClose: () => void;
}

/**
 * Create a space with its first members in one flow — a space is never empty,
 * so Create stays disabled until a name and at least one project are chosen.
 */
function NewSpaceModal({ projects, initialProjectIds, onClose }: NewSpaceModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [name, setName] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set(initialProjectIds ?? []));
	const [saving, setSaving] = useState(false);

	useEscapeKey(onClose);

	// Operations is outside the grouping model; spaces hold git projects.
	const candidates = orderProjectsForDisplay(
		projects.filter((p) => !p.deleted && !isBuiltinOpsProject(p)),
	);

	const canCreate = name.trim().length > 0 && selected.size > 0 && !saving;

	function toggle(projectId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}

	async function handleCreate() {
		if (!canCreate) return;
		setSaving(true);
		try {
			await api.request.createSpace({ name: name.trim(), projectIds: [...selected] });
			onClose();
		} catch (err) {
			toast.error(t("spaces.failedCreate", { error: String(err) }));
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
				aria-labelledby="new-space-dialog-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26rem] p-6 space-y-4 outline-none"
			>
				<h2 id="new-space-dialog-title" className="text-fg text-lg font-semibold">
					{t("spaces.newSpace")}
				</h2>

				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t("spaces.namePlaceholder")}
					autoFocus
					className="w-full bg-elevated border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
					data-testid="new-space-name"
				/>

				<div>
					<div className="text-xs text-fg-3 mb-1.5">{t("spaces.selectProjects")}</div>
					<div className="max-h-56 overflow-y-auto rounded-lg border border-edge divide-y divide-edge/40">
						{candidates.map((project) => (
							<label
								key={project.id}
								className="flex items-center gap-2.5 px-3 py-2 hover:bg-overlay-hover transition-colors cursor-pointer"
							>
								<input
									type="checkbox"
									checked={selected.has(project.id)}
									onChange={() => toggle(project.id)}
									className="w-3.5 h-3.5 rounded accent-accent"
									data-testid={`new-space-project-${project.id}`}
								/>
								<span className="text-xs text-fg truncate">{project.name}</span>
							</label>
						))}
						{candidates.length === 0 && (
							<div className="px-3 py-4 text-xs text-fg-muted text-center">{t("spaces.noProjects")}</div>
						)}
					</div>
				</div>

				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-overlay-hover transition-colors"
					>
						{t("spaces.cancel")}
					</button>
					<button
						type="button"
						onClick={handleCreate}
						disabled={!canCreate}
						className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						data-testid="new-space-create"
					>
						{t("spaces.create")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default NewSpaceModal;
