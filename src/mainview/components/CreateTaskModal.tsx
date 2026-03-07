import { useState, useEffect, useRef, useCallback, type Dispatch } from "react";
import type { Label, Project, Task } from "../../shared/types";
import { titleFromDescription } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import LabelChip from "./LabelChip";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import { useImagePaste } from "../hooks/useImagePaste";
import { useFileDrop } from "../hooks/useFileDrop";
import { removeImagePath } from "../utils/imageAttachments";
import BranchSelector from "./BranchSelector";

interface CreateTaskModalProps {
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	onCreateAndRun?: (task: Task) => void;
}

function CreateTaskModal({ project, dispatch, onClose, onCreateAndRun }: CreateTaskModalProps) {
	const t = useT();
	const [description, setDescription] = useState("");
	const [creating, setCreating] = useState(false);
	const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [customTitle, setCustomTitle] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState(false);
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const keepEditingRef = useRef<HTMLButtonElement>(null);
	const projectLabels = project.labels ?? [];

	const insertPathAtCursor = useCallback((path: string) => {
		const el = textareaRef.current;
		if (!el) {
			setDescription((prev) => prev + (prev && !prev.endsWith("\n") ? "\n" : "") + path + "\n");
			return;
		}
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const val = el.value;
		const prefix = start > 0 && val[start - 1] !== "\n" ? "\n" : "";
		const insert = prefix + path + "\n";
		const next = val.slice(0, start) + insert + val.slice(end);
		setDescription(next);
		requestAnimationFrame(() => {
			const pos = start + insert.length;
			el.selectionStart = pos;
			el.selectionEnd = pos;
			el.focus();
		});
	}, []);

	const { handlePaste, isPasting } = useImagePaste(project.id, insertPathAtCursor);
	const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging } = useFileDrop(insertPathAtCursor);

	const handleRemovePath = useCallback((path: string) => {
		setDescription((prev) => removeImagePath(prev, path));
	}, []);

	const generatedTitle = description.trim()
		? titleFromDescription(description)
		: "";

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	function handleRequestClose() {
		if (description.trim()) {
			setConfirmDiscard(true);
		} else {
			onClose();
		}
	}

	useEffect(() => {
		if (confirmDiscard) {
			keepEditingRef.current?.focus();
		}
	}, [confirmDiscard]);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (confirmDiscard) {
					setConfirmDiscard(false);
				} else {
					handleRequestClose();
				}
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [description, onClose, confirmDiscard]);

	async function handleCreate() {
		const trimmed = description.trim();
		if (!trimmed || creating) return;
		setCreating(true);
		try {
			let task = await api.request.createTask({
				projectId: project.id,
				description: trimmed,
				...(selectedBranch ? { existingBranch: selectedBranch } : {}),
			});
			if (customTitle) {
				task = await api.request.renameTask({
					taskId: task.id,
					projectId: project.id,
					customTitle,
				});
			}
			if (selectedLabelIds.length > 0) {
				task = await api.request.setTaskLabels({
					taskId: task.id,
					projectId: project.id,
					labelIds: selectedLabelIds,
				});
			}
			dispatch({ type: "addTask", task });
			trackEvent("task_created", { project_id: project.id });
			onClose();
		} catch (err) {
			alert(t("kanban.failedCreate", { error: String(err) }));
			setCreating(false);
		}
	}

	async function handleCreateAndRun() {
		const trimmed = description.trim();
		if (!trimmed || creating || !onCreateAndRun) return;
		setCreating(true);
		try {
			let task = await api.request.createTask({
				projectId: project.id,
				description: trimmed,
				...(selectedBranch ? { existingBranch: selectedBranch } : {}),
			});
			if (customTitle) {
				task = await api.request.renameTask({
					taskId: task.id,
					projectId: project.id,
					customTitle,
				});
			}
			if (selectedLabelIds.length > 0) {
				task = await api.request.setTaskLabels({
					taskId: task.id,
					projectId: project.id,
					labelIds: selectedLabelIds,
				});
			}
			dispatch({ type: "addTask", task });
			trackEvent("task_created", { project_id: project.id, source: "create_and_run" });
			onCreateAndRun(task);
		} catch (err) {
			alert(t("kanban.failedCreate", { error: String(err) }));
			setCreating(false);
		}
	}

	function toggleLabel(label: Label) {
		setSelectedLabelIds((prev) =>
			prev.includes(label.id) ? prev.filter((id) => id !== label.id) : [...prev, label.id],
		);
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[32.5rem] p-6 space-y-5">
				<h2 className="text-fg text-lg font-semibold">
					{t("createTask.title")}
				</h2>

				{/* Description textarea + drop zone */}
				<div className="space-y-1.5">
					<label className="text-fg-2 text-sm font-medium">
						{t("createTask.descriptionLabel")}
					</label>

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
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									if (e.shiftKey && onCreateAndRun) {
										handleCreateAndRun();
									} else {
										handleCreate();
									}
								}
							}}
							onPaste={handlePaste}
							placeholder={t("createTask.descriptionPlaceholder")}
							rows={4}
							className="w-full px-3 py-2.5 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors resize-y min-h-[5rem] max-h-[18.75rem]"
						/>
					</div>
					{isPasting && (
						<span className="text-[0.6875rem] text-accent animate-pulse">{t("images.pasting")}</span>
					)}
					<ImageAttachmentsStrip text={description} onRemovePath={handleRemovePath} />
					{generatedTitle && (
						<div className="text-xs">
							{editingTitle ? (
								<div className="flex items-center gap-1.5">
									<span className="text-fg-3 flex-shrink-0">{t("createTask.generatedTitle")}</span>
									<input
										ref={titleInputRef}
										type="text"
										value={customTitle ?? generatedTitle}
										onChange={(e) => {
											const val = e.target.value;
											// If user clears or matches auto-generated, revert to auto
											if (!val.trim() || val.trim() === generatedTitle) {
												setCustomTitle(null);
											} else {
												setCustomTitle(val);
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Escape") {
												setEditingTitle(false);
											} else if (e.key === "Enter") {
												setEditingTitle(false);
											}
										}}
										onBlur={() => setEditingTitle(false)}
										className="flex-1 bg-elevated border border-edge-active rounded-md px-2 py-0.5 text-xs text-fg font-medium outline-none focus:border-accent/60 transition-colors"
									/>
									{customTitle && (
										<button
											onMouseDown={(e) => {
												e.preventDefault();
												setCustomTitle(null);
												setEditingTitle(false);
											}}
											className="text-fg-muted hover:text-danger text-[0.625rem] flex-shrink-0 transition-colors"
											title={t("task.resetTitle")}
										>
											✕
										</button>
									)}
								</div>
							) : (
								<div
									className="group/title flex items-center gap-1.5 cursor-pointer rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-fg/5 transition-colors"
									onClick={() => {
										setEditingTitle(true);
										setTimeout(() => titleInputRef.current?.focus(), 0);
									}}
								>
									<span className="text-fg-3">{t("createTask.generatedTitle")}</span>
									<span className={`font-medium group-hover/title:underline ${customTitle ? "text-accent" : "text-fg-2"}`}>
										{customTitle ?? generatedTitle}
									</span>
									<svg className="w-3 h-3 text-fg-muted opacity-0 group-hover/title:opacity-100 transition-opacity flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
									</svg>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Label selector — only shown if project has labels */}
				{projectLabels.length > 0 && (
					<div className="space-y-2">
						<label className="text-fg-2 text-sm font-medium">
							{t("labels.taskLabels")}
						</label>
						<div className="flex flex-wrap gap-1.5">
							{projectLabels.map((label) => (
								<LabelChip
									key={label.id}
									label={label}
									size="sm"
									active={selectedLabelIds.includes(label.id)}
									onClick={() => toggleLabel(label)}
								/>
							))}
						</div>
					</div>
				)}

				{/* Branch selector — collapsible */}
				<BranchSelector
					projectId={project.id}
					selectedBranch={selectedBranch}
					onSelectBranch={setSelectedBranch}
				/>

			{/* Actions */}
				<div className="space-y-2.5 pt-1">
					{confirmDiscard ? (
						<div className="flex items-center justify-between gap-2 bg-danger/10 border border-danger/30 rounded-xl px-3 py-2.5">
							<span className="text-fg-2 text-sm">{t("createTask.discardConfirm")}</span>
							<div className="flex gap-2 shrink-0">
								<button
									ref={keepEditingRef}
									onClick={() => setConfirmDiscard(false)}
									className="px-3 py-1 text-fg-3 text-sm hover:text-fg transition-colors rounded-lg focus:outline-none focus:ring-2 focus:ring-edge-active focus:text-fg"
								>
									{t("createTask.keepEditing")}
								</button>
								<button
									onClick={onClose}
									className="px-3 py-1 bg-danger text-white text-sm font-medium rounded-lg hover:bg-danger/80 transition-colors"
								>
									{t("createTask.discard")}
								</button>
							</div>
						</div>
					) : (
						<>
							<div className="flex items-center justify-end gap-2">
								<button
									onClick={handleRequestClose}
									className="px-4 py-1.5 text-fg-3 text-sm hover:text-fg transition-colors rounded-lg"
								>
									{t("kanban.cancel")}
								</button>
								{onCreateAndRun && (
									<button
										onClick={handleCreateAndRun}
										disabled={!description.trim() || creating}
										className="px-3.5 py-1.5 bg-green-600/90 text-white text-xs font-medium rounded-lg hover:bg-green-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
									>
										<svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
											<path d="M8 5v14l11-7z" />
										</svg>
										{t("createTask.createAndRun")}
									</button>
								)}
								<button
									onClick={handleCreate}
									disabled={!description.trim() || creating}
									className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
								>
									{creating ? t("createTask.creating") : t("createTask.create")}
								</button>
							</div>
							<div className="text-fg-muted text-[0.6875rem] text-right">
								{onCreateAndRun
									? t("createTask.submitHintRun")
									: t("createTask.submitHint")}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

export default CreateTaskModal;
