import { useState, useEffect, useRef, type Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import { STATUS_COLORS, titleFromDescription } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { trackEvent } from "../analytics";

interface TaskDetailModalProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function TaskDetailModal({ task, project, dispatch, onClose }: TaskDetailModalProps) {
	const t = useT();
	const isTodo = task.status === "todo";
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(task.description);
	const [saving, setSaving] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (isEditing) {
					setIsEditing(false);
				} else {
					onClose();
				}
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose, isEditing]);

	useEffect(() => {
		if (isEditing) {
			setTimeout(() => textareaRef.current?.focus(), 0);
		}
	}, [isEditing]);

	function handleStartEdit() {
		setEditValue(task.description);
		setIsEditing(true);
	}

	async function handleSave() {
		const trimmed = editValue.trim();
		if (!trimmed || trimmed === task.description) {
			setIsEditing(false);
			return;
		}
		setSaving(true);
		try {
			const updated = await api.request.editTask({
				taskId: task.id,
				projectId: project.id,
				description: trimmed,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_edited", { project_id: project.id });
			setIsEditing(false);
		} catch (err) {
			alert(t("task.failedEdit", { error: String(err) }));
		}
		setSaving(false);
	}

	function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Escape") {
			e.preventDefault();
			setIsEditing(false);
		} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSave();
		}
	}

	const color = STATUS_COLORS[task.status];
	const generatedTitle = editValue.trim() ? titleFromDescription(editValue) : "";

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && !isEditing) onClose();
			}}
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-6 pt-5 pb-3">
					<div className="flex items-center gap-3">
						<span className="text-fg-muted text-xs font-mono">#{task.seq}</span>
						<div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-fg/5">
							<div
								className="w-2 h-2 rounded-full flex-shrink-0"
								style={{ background: color }}
							/>
							<span className="text-xs text-fg-2">
								{t(statusKey(task.status))}
							</span>
						</div>
					</div>
					<button
						onClick={onClose}
						className="w-7 h-7 flex items-center justify-center rounded-lg text-fg-3 hover:text-fg hover:bg-fg/8 transition-colors"
						title={t("task.close")}
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Content */}
				<div className="px-6 pb-5 overflow-y-auto flex-1">
					{/* Title preview */}
					<div className="text-fg text-base font-semibold leading-relaxed mb-4">
						{isEditing ? (generatedTitle || task.title) : task.title}
					</div>

					{/* Description */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<label className="text-fg-3 text-xs font-medium uppercase tracking-wider">
								{t("task.descriptionLabel")}
							</label>
							{isTodo && !isEditing && (
								<button
									onClick={handleStartEdit}
									className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
								>
									{t("task.edit")}
								</button>
							)}
						</div>

						{isEditing ? (
							<div className="space-y-2">
								<textarea
									ref={textareaRef}
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={handleEditKeyDown}
									rows={8}
									className="w-full bg-elevated border border-edge-active rounded-xl px-3 py-2.5 text-sm text-fg leading-relaxed resize-y outline-none focus:border-accent/60 transition-colors min-h-[120px] max-h-[400px]"
									disabled={saving}
								/>
								{generatedTitle && generatedTitle !== editValue.trim() && (
									<div className="text-fg-3 text-xs">
										{t("createTask.generatedTitle")}{" "}
										<span className="text-fg-2 font-medium">{generatedTitle}</span>
									</div>
								)}
								<div className="flex items-center justify-between">
									<span className="text-xs text-fg-muted">{t("task.editHint")}</span>
									<div className="flex gap-1.5">
										<button
											onClick={() => setIsEditing(false)}
											className="text-xs px-2.5 py-1 rounded-lg text-fg-2 hover:bg-fg/8 transition-colors"
											disabled={saving}
										>
											{t("task.editCancel")}
										</button>
										<button
											onClick={handleSave}
											className="text-xs px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent-hover font-semibold transition-colors disabled:opacity-50"
											disabled={saving || !editValue.trim()}
										>
											{t("task.editSave")}
										</button>
									</div>
								</div>
							</div>
						) : (
							<div className="text-fg-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
								{task.description}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

export default TaskDetailModal;
