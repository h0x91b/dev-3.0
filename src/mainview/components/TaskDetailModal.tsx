import { useState, useEffect, useRef, useCallback, type Dispatch } from "react";
import { toast } from "../toast";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { titleFromDescription, getAllowedTransitions, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import { NoteItem, formatDate } from "./NoteItem";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { trackEvent, agentNameFromId } from "../analytics";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { useFileDrop } from "../hooks/useFileDrop";
import { removeImagePath } from "../utils/imageAttachments";

interface TaskDetailModalProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	/** Opens the LaunchVariantsModal to start a todo task (agent + variant picker). */
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
}

function TaskDetailModal({ task, project, dispatch, onClose, onLaunchVariants }: TaskDetailModalProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const isTodo = task.status === "todo";
	const isArchived = task.status === "completed" || task.status === "cancelled";
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(task.description);
	const [saving, setSaving] = useState(false);
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [renameSaving, setRenameSaving] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const pickerAnchorRef = useRef<HTMLButtonElement>(null);

	useEscapeKey(() => {
		if (pickerOpen) {
			setPickerOpen(false);
		} else if (statusMenuOpen) {
			setStatusMenuOpen(false);
		} else if (isRenaming) {
			setIsRenaming(false);
		} else if (isEditing) {
			setIsEditing(false);
		} else {
			onClose();
		}
	});

	useEffect(() => {
		if (isEditing) {
			setTimeout(() => textareaRef.current?.focus(), 0);
		}
	}, [isEditing]);

	function handleStartEdit() {
		setEditValue(task.description);
		setIsEditing(true);
	}

	// Insert an uploaded/pasted path into the edit textarea at the caret, mirroring
	// CreateTaskModal so editing a todo task supports drag-drop and paste image upload.
	const insertPathAtCursor = useCallback((path: string) => {
		setEditValue((prev) => {
			const el = textareaRef.current;
			if (!el) {
				return prev + (prev && !prev.endsWith("\n") ? "\n" : "") + path + "\n";
			}
			const start = el.selectionStart;
			const end = el.selectionEnd;
			const prefix = start > 0 && prev[start - 1] !== "\n" ? "\n" : "";
			const insert = prefix + path + "\n";
			const next = prev.slice(0, start) + insert + prev.slice(end);
			requestAnimationFrame(() => {
				const pos = start + insert.length;
				el.selectionStart = pos;
				el.selectionEnd = pos;
				el.focus();
			});
			return next;
		});
	}, []);

	const handleRemovePath = useCallback((path: string) => {
		setEditValue((prev) => removeImagePath(prev, path));
	}, []);

	const { handlePaste, isPasting, pasteKind } = useClipboardPaste(project.id, insertPathAtCursor);
	const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging } = useFileDrop(project.id, insertPathAtCursor);

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
			toast.error(t("task.failedEdit", { error: String(err) }));
		}
		setSaving(false);
	}

	function handleStartRename() {
		setRenameValue(getTaskTitle(task));
		setIsRenaming(true);
		setTimeout(() => renameInputRef.current?.focus(), 0);
	}

	async function handleRenameSave() {
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === getTaskTitle(task)) {
			setIsRenaming(false);
			return;
		}
		setRenameSaving(true);
		try {
			const updated = await api.request.renameTask({
				taskId: task.id,
				projectId: project.id,
				customTitle: trimmed,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_renamed", { project_id: project.id });
			setIsRenaming(false);
		} catch (err) {
			toast.error(t("task.failedRename", { error: String(err) }));
		}
		setRenameSaving(false);
	}

	async function handleResetTitle() {
		setRenameSaving(true);
		try {
			const updated = await api.request.renameTask({
				taskId: task.id,
				projectId: project.id,
				customTitle: null,
			});
			dispatch({ type: "updateTask", task: updated });
			setIsRenaming(false);
		} catch (err) {
			toast.error(t("task.failedRename", { error: String(err) }));
		}
		setRenameSaving(false);
	}

	function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Escape") {
			e.preventDefault();
			setIsRenaming(false);
		} else if (e.key === "Enter") {
			e.preventDefault();
			handleRenameSave();
		}
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

	async function handleMoveToCustomColumn(customColumnId: string) {
		setMovingStatus(true);
		setStatusMenuOpen(false);
		try {
			const updated = await api.request.moveTaskToCustomColumn({
				taskId: task.id,
				projectId: project.id,
				customColumnId,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}`, agent_name: agentNameFromId(task.agentId) });
			onClose();
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }));
		}
		setMovingStatus(false);
	}

	async function handleStatusMove(newStatus: TaskStatus) {
		setStatusMenuOpen(false);
		await moveTaskToStatus({
			task,
			project,
			newStatus,
			dispatch,
			t,
			afterOptimistic: () => onClose(),
		});
	}

	// ---- Footer action handlers (todo) ----

	/** Start the task: close this modal and hand off to the launch-variants flow. */
	function handleRun() {
		onClose();
		onLaunchVariants(task, "in-progress");
	}

	async function handleDelete() {
		const confirmed = await confirm({
			title: t("task.delete"),
			message: t("task.confirmDelete", { title: getTaskTitle(task) }),
			danger: true,
		});
		if (!confirmed) return;
		setDeleting(true);
		try {
			await api.request.deleteTask({ taskId: task.id, projectId: project.id });
			dispatch({ type: "removeTask", taskId: task.id });
			trackEvent("task_deleted", { project_id: project.id });
			onClose();
		} catch (err) {
			toast.error(t("task.failedDelete", { error: String(err) }));
			setDeleting(false);
		}
	}

	async function handleRemoveLabel(labelId: string) {
		try {
			const updated = await api.request.setTaskLabels({
				taskId: task.id,
				projectId: project.id,
				labelIds: (task.labelIds ?? []).filter((id) => id !== labelId),
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("labels.failedSetLabels", { error: String(err) }));
		}
	}

	async function handleToggleLabel(labelId: string) {
		const ids = task.labelIds ?? [];
		const newIds = ids.includes(labelId)
			? ids.filter((id) => id !== labelId)
			: [...ids, labelId];
		try {
			const updated = await api.request.setTaskLabels({
				taskId: task.id,
				projectId: project.id,
				labelIds: newIds,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("labels.failedSetLabels", { error: String(err) }));
		}
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
			toast.error(t("notes.failedAdd", { error: String(err) }));
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
			toast.error(t("notes.failedDelete", { error: String(err) }));
		}
	}

	const color = statusColors[task.status];
	const generatedTitle = editValue.trim() ? titleFromDescription(editValue) : "";
	const assignedLabels = (task.labelIds ?? [])
		.map((id) => (project.labels ?? []).find((l) => l.id === id))
		.filter(Boolean) as NonNullable<typeof project.labels>[number][];

	if (isArchived) {
		return <ArchivedView
			task={task}
			project={project}
			color={color}
			statusMenuOpen={statusMenuOpen}
			setStatusMenuOpen={setStatusMenuOpen}
			movingStatus={movingStatus}
			onStatusMove={handleStatusMove}
			onMoveToCustomColumn={handleMoveToCustomColumn}
			onAddNote={handleAddNote}
			onUpdateNote={handleUpdateNote}
			onDeleteNote={handleDeleteNote}
			onClose={onClose}
		/>;
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && !isEditing) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[35rem] max-h-[80vh] flex flex-col outline-none"
			>
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
								{getStatusLabel(task.status, t, project)}
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
					{/* Title with rename */}
					{isRenaming ? (
						<div className="mb-4 space-y-1.5">
							<input
								ref={renameInputRef}
								type="text"
								value={renameValue}
								onChange={(e) => setRenameValue(e.target.value)}
								onKeyDown={handleRenameKeyDown}
								className="w-full bg-elevated border border-edge-active rounded-lg px-3 py-2 text-base text-fg font-semibold leading-relaxed outline-none focus:border-accent/60 transition-colors"
								disabled={renameSaving}
							/>
							<div className="flex items-center justify-between">
								<span className="text-xs text-fg-muted">Enter to save · Esc to cancel</span>
								<div className="flex gap-1.5">
									{task.customTitle && (
										<button
											onClick={handleResetTitle}
											className="text-xs px-2.5 py-1 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 transition-colors"
											disabled={renameSaving}
										>
											{t("task.resetTitle")}
										</button>
									)}
									<button
										onClick={() => setIsRenaming(false)}
										className="text-xs px-2.5 py-1 rounded-lg text-fg-2 hover:bg-fg/8 transition-colors"
										disabled={renameSaving}
									>
										{t("task.editCancel")}
									</button>
									<button
										onClick={handleRenameSave}
										className="text-xs px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent-hover font-semibold transition-colors disabled:opacity-50"
										disabled={renameSaving || !renameValue.trim()}
									>
										{t("task.editSave")}
									</button>
								</div>
							</div>
						</div>
					) : (
						<div className="group/title flex items-start gap-2 mb-4">
							<div
								className={`text-fg text-base font-semibold leading-relaxed flex-1 ${!isEditing ? "cursor-pointer hover:text-fg-2" : ""}`}
								onClick={!isEditing ? handleStartRename : undefined}
							>
								{isEditing ? (generatedTitle || getTaskTitle(task)) : getTaskTitle(task)}
							</div>
							{!isEditing && (
								<button
									onClick={handleStartRename}
									className="flex-shrink-0 mt-0.5 text-fg-muted hover:text-fg p-1 rounded-md hover:bg-fg/8 transition-all"
									title={t("task.renameTitle")}
								>
									<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
									</svg>
								</button>
							)}
						</div>
					)}

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
								<div
									className="relative"
									onDragOver={handleDragOver}
									onDragEnter={handleDragEnter}
									onDragLeave={handleDragLeave}
									onDrop={handleDrop}
								>
									{isDragging && (
										<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 pointer-events-none">
											<div className="flex items-center gap-2 text-accent font-medium text-sm">
												<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
												</svg>
												{t("images.dropHere")}
											</div>
										</div>
									)}
									<textarea
										ref={textareaRef}
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onKeyDown={handleEditKeyDown}
										onPaste={handlePaste}
										rows={8}
										className="w-full bg-elevated border border-edge-active rounded-xl px-3 py-2.5 text-sm text-fg leading-relaxed resize-y outline-none focus:border-accent/60 transition-colors min-h-[7.5rem] max-h-[25rem]"
										disabled={saving}
									/>
								</div>
								{isPasting && (
									<span className="text-[0.6875rem] text-accent animate-pulse">{t(pasteKind === "text" ? "paste.savingText" : "images.pasting")}</span>
								)}
								<ImageAttachmentsStrip text={editValue} onRemovePath={handleRemovePath} />
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

				{/* Footer — actions for a not-yet-started task */}
				{isTodo && (
					<div className="flex-shrink-0 border-t border-edge px-6 py-4 space-y-3">
						{/* Labels */}
						<div className="flex flex-wrap items-center gap-1.5">
							{assignedLabels.map((label) => (
								<LabelChip
									key={label.id}
									label={label}
									size="xs"
									onRemove={(e) => {
										e.stopPropagation();
										handleRemoveLabel(label.id);
									}}
								/>
							))}
							<button
								ref={pickerAnchorRef}
								type="button"
								onClick={() => setPickerOpen(true)}
								className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-3 transition-colors hover:bg-fg/8 hover:text-fg"
							>
								{t("labels.addLabel")}
							</button>
							{pickerOpen && pickerAnchorRef.current && (
								<LabelPicker
									project={project}
									dispatch={dispatch}
									onClose={() => setPickerOpen(false)}
									anchorEl={pickerAnchorRef.current}
									selectedIds={task.labelIds ?? []}
									onToggle={handleToggleLabel}
								/>
							)}
						</div>

						{/* Primary + destructive actions */}
						<div className="flex items-center justify-between">
							<button
								onClick={handleDelete}
								disabled={deleting}
								className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-fg-3 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
							>
								{t("task.delete")}
							</button>
							<button
								onClick={handleRun}
								disabled={deleting}
								className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-green-900/30 transition-colors hover:bg-green-500 disabled:opacity-50"
								title={t("task.run")}
							>
								<svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
									<path d="M8 5v14l11-7z" />
								</svg>
								{t("task.run")}
							</button>
						</div>
					</div>
				)}
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
	onMoveToCustomColumn: (customColumnId: string) => void;
	onAddNote: () => void;
	onUpdateNote: (noteId: string, content: string) => void;
	onDeleteNote: (noteId: string) => void;
	onClose: () => void;
}

function ArchivedView({
	task, project, color,
	statusMenuOpen, setStatusMenuOpen,
	movingStatus, onStatusMove, onMoveToCustomColumn,
	onAddNote, onUpdateNote, onDeleteNote,
	onClose,
}: ArchivedViewProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const menuRef = useRef<HTMLDivElement>(null);
	const trapRef = useFocusTrap<HTMLDivElement>();

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
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col outline-none"
			>
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
									{getStatusLabel(task.status, t, project)}
								</span>
								<svg className="w-3 h-3 text-fg-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>

							{statusMenuOpen && (
								<div className="absolute top-full left-0 mt-1 z-10 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]">
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
												style={{ background: statusColors[s] }}
											/>
											{getStatusLabel(s, t, project)}
										</button>
									))}
									{project.customColumns && project.customColumns.length > 0 && (
										<>
											<div className="border-t border-edge-active mt-1.5 pt-1.5" />
											{project.customColumns
												.filter((col) => col.id !== task.customColumnId)
												.map((col) => (
													<button
														key={col.id}
														onClick={() => onMoveToCustomColumn(col.id)}
														className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
													>
														<div
															className="w-2.5 h-2.5 rounded-full flex-shrink-0"
															style={{ background: col.color }}
														/>
														{col.name}
													</button>
												))}
										</>
									)}
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
								{getTaskTitle(task)}
							</div>

							{task.description && task.description !== getTaskTitle(task) && (
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
