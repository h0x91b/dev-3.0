import { useState, useEffect, useRef, type Dispatch } from "react";
import type { Project } from "../../shared/types";
import { titleFromDescription } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";

interface CreateTaskModalProps {
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function CreateTaskModal({ project, dispatch, onClose }: CreateTaskModalProps) {
	const t = useT();
	const [description, setDescription] = useState("");
	const [creating, setCreating] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const generatedTitle = description.trim()
		? titleFromDescription(description)
		: "";

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose]);

	async function handleCreate() {
		const trimmed = description.trim();
		if (!trimmed || creating) return;
		setCreating(true);
		try {
			const task = await api.request.createTask({
				projectId: project.id,
				description: trimmed,
			});
			dispatch({ type: "addTask", task });
			trackEvent("task_created", { project_id: project.id });
			onClose();
		} catch (err) {
			alert(t("kanban.failedCreate", { error: String(err) }));
			setCreating(false);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[520px] p-6 space-y-5">
				<h2 className="text-fg text-lg font-semibold">
					{t("createTask.title")}
				</h2>

				{/* Description textarea */}
				<div className="space-y-1.5">
					<label className="text-fg-2 text-sm font-medium">
						{t("createTask.descriptionLabel")}
					</label>
					<textarea
						ref={textareaRef}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								handleCreate();
							}
						}}
						placeholder={t("createTask.descriptionPlaceholder")}
						rows={4}
						className="w-full px-3 py-2.5 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors resize-y min-h-[80px] max-h-[300px]"
					/>
					{generatedTitle && (
						<div className="text-fg-3 text-xs">
							{t("createTask.generatedTitle")}{" "}
							<span className="text-fg-2 font-medium">{generatedTitle}</span>
						</div>
					)}
				</div>

				{/* Actions */}
				<div className="flex items-center justify-between pt-1">
					<span className="text-fg-muted text-xs">
						{t("createTask.submitHint")}
					</span>
					<div className="flex gap-2">
						<button
							onClick={onClose}
							className="px-4 py-2 text-fg-3 text-sm hover:text-fg transition-colors rounded-xl"
						>
							{t("kanban.cancel")}
						</button>
						<button
							onClick={handleCreate}
							disabled={!description.trim() || creating}
							className="px-5 py-2 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{creating ? t("createTask.creating") : t("createTask.create")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default CreateTaskModal;
