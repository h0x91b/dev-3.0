import { useState, useEffect, useRef, type Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { STATUS_COLORS, titleFromDescription, getAllowedTransitions } from "../../shared/types";
import LabelChip from "./LabelChip";
import { NoteItem, formatDate } from "./NoteItem";
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
	const isArchived = task.status === "completed" || task.status === "cancelled";
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(task.description);
	const [saving, setSaving] = useState(false);
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (statusMenuOpen) {
					setStatusMenuOpen(false);
				} else if (isEditing) {
					setIsEditing(false);
				} else {
					onClose();
				}
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose, isEditing, statusMenuOpen]);

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

	async function handleStatusMove(newStatus: TaskStatus) {
		setMovingStatus(true);
		setStatusMenuOpen(false);
		const fromStatus = task.status;
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			onClose();
		} catch (err) {
			try {
				const updated = await api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				});
				dispatch({ type: "updateTask", task: updated });
				trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
				onClose();
			} catch (retryErr) {
				alert(t("task.failedMove", { error: String(retryErr) }));
			}
		}
		setMovingStatus(false);
	}

	// ---- Notes handlers ----

	async function handleAddNote() {
		try {
			const updated = await api.request.addTaskNote({
				taskId: task.id,
				projectId: project.id,
				content: "",
				source: "user",
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(t("notes.failedAdd", { error: String(err) }));
		}
	}

	async function handleUpdateNote(noteId: string, content: string) {
		try {
			const updated = await api.request.updateTaskNote({
				taskId: task.id,
				projectId: project.id,
				noteId,
				content,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			console.error("Failed to auto-save note:", err);
		}
	}

	async function handleDeleteNote(noteId: string) {
		try {
			const updated = await api.request.deleteTaskNote({
				taskId: task.id,
				projectId: project.id,
				noteId,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(t("notes.failedDelete", { error: String(err) }));
		}
	}

	const color = STATUS_COLORS[task.status];
	const generatedTitle = editValue.trim() ? titleFromDescription(editValue) : "";

	if (isArchived) {
		return <ArchivedView
			task={task}
			project={project}
			color={color}
			statusMenuOpen={statusMenuOpen}
			setStatusMenuOpen={setStatusMenuOpen}
			movingStatus={movingStatus}
			onStatusMove={handleStatusMove}
			onAddNote={handleAddNote}
			onUpdateNote={handleUpdateNote}
			onDeleteNote={handleDeleteNote}
			onClose={onClose}
		/>;
	}

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

// ---- Full-screen archived task view ----

interface ArchivedViewProps {
	task: Task;
	project: Project;
	color: string;
	statusMenuOpen: boolean;
	setStatusMenuOpen: (open: boolean) => void;
	movingStatus: boolean;
	onStatusMove: (status: TaskStatus) => void;
	onAddNote: () => void;
	onUpdateNote: (noteId: string, content: string) => void;
	onDeleteNote: (noteId: string) => void;
	onClose: () => void;
}

function ArchivedView({
	task, project, color,
	statusMenuOpen, setStatusMenuOpen,
	movingStatus, onStatusMove,
	onAddNote, onUpdateNote, onDeleteNote,
	onClose,
}: ArchivedViewProps) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);

	// Close status menu on click outside
	useEffect(() => {
		if (!statusMenuOpen) return;
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setStatusMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [statusMenuOpen, setStatusMenuOpen]);

	const labels = (task.labelIds ?? [])
		.map((id) => (project.labels ?? []).find((l) => l.id === id))
		.filter(Boolean) as NonNullable<typeof project.labels>[number][];

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			data-testid="archived-task-modal"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-edge">
					<div className="flex items-center gap-3">
						<span className="text-fg-muted text-xs font-mono">#{task.seq}</span>

						{/* Status badge with dropdown */}
						<div className="relative" ref={menuRef}>
							<button
								onClick={() => setStatusMenuOpen(!statusMenuOpen)}
								disabled={movingStatus}
								className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-fg/5 hover:bg-elevated transition-colors"
							>
								<div
									className="w-2 h-2 rounded-full flex-shrink-0"
									style={{ background: color }}
								/>
								<span className="text-xs text-fg-2">
									{t(statusKey(task.status))}
								</span>
								<svg className="w-3 h-3 text-fg-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>

							{statusMenuOpen && (
								<div className="absolute top-full left-0 mt-1 z-10 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[180px]">
									<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
										{t("task.reopenTo")}
									</div>
									{getAllowedTransitions(task.status).map((s) => (
										<button
											key={s}
											onClick={() => onStatusMove(s)}
											className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
										>
											<div
												className="w-2.5 h-2.5 rounded-full flex-shrink-0"
												style={{ background: STATUS_COLORS[s] }}
											/>
											{t(statusKey(s))}
										</button>
									))}
								</div>
							)}
						</div>

						{/* Labels */}
						{labels.map((label) => (
							<LabelChip key={label.id} label={label} size="xs" />
						))}
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

				{/* Body */}
				<div className="flex-1 overflow-y-auto">
					<div className="flex flex-col lg:flex-row">
						{/* Left: title + description + notes */}
						<div className="flex-1 px-6 py-5 min-w-0">
							<div className="text-fg text-lg font-semibold leading-relaxed mb-4">
								{task.title}
							</div>

							{task.description && task.description !== task.title && (
								<div className="mb-6">
									<label className="text-fg-3 text-xs font-medium uppercase tracking-wider mb-2 block">
										{t("task.descriptionLabel")}
									</label>
									<div className="text-fg-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
										{task.description}
									</div>
								</div>
							)}

							{/* Notes */}
							<div className="border-t border-edge pt-4">
								<div className="flex items-center justify-between mb-3">
									<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
										{t("notes.title")}
									</span>
									<button
										onClick={onAddNote}
										className="text-xs text-accent hover:text-accent-hover transition-colors"
									>
										{t("notes.add")}
									</button>
								</div>
								{(task.notes ?? []).length === 0 && (
									<span className="text-xs text-fg-muted">{t("notes.empty")}</span>
								)}
								{(task.notes ?? []).map(note => (
									<NoteItem
										key={note.id}
										note={note}
										onSave={(content) => onUpdateNote(note.id, content)}
										onDelete={() => onDeleteNote(note.id)}
									/>
								))}
							</div>
						</div>

						{/* Right: metadata sidebar */}
						<div className="w-full lg:w-72 flex-shrink-0 border-t lg:border-t-0 lg:border-l border-edge px-6 py-5">
							<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-xs">
								<span className="text-fg-3">{t("infoPanel.taskNumber")}</span>
								<span className="text-fg-2 font-mono font-semibold">#{task.seq}</span>

								{task.branchName && (
									<>
										<span className="text-fg-3">{t("infoPanel.branch")}</span>
										<span className="text-fg-2 font-mono truncate">{task.branchName}</span>
									</>
								)}

								{task.baseBranch && (
									<>
										<span className="text-fg-3">{t("infoPanel.baseBranch")}</span>
										<span className="text-fg-2 font-mono">{task.baseBranch}</span>
									</>
								)}

								<span className="text-fg-3">{t("infoPanel.created")}</span>
								<span className="text-fg-3">{formatDate(task.createdAt)}</span>

								<span className="text-fg-3">{t("infoPanel.updated")}</span>
								<span className="text-fg-3">{formatDate(task.updatedAt)}</span>

								{task.movedAt && (
									<>
										<span className="text-fg-3">{t("infoPanel.movedAt")}</span>
										<span className="text-fg-3">{formatDate(task.movedAt)}</span>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export default TaskDetailModal;
