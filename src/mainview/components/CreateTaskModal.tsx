import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import { toast } from "../toast";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { DEFAULT_PRIORITY, isBuiltinOpsProject, orderProjectsForDisplay, titleFromDescription, type Project, type Task, type TaskPriority } from "../../shared/types";
import type { AppAction } from "../state";
import { api, isElectrobun } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import PriorityBadge from "./PriorityBadge";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { useAttachUpload } from "../hooks/useAttachUpload";
import { useFileDrop } from "../hooks/useFileDrop";
import { useSkillAutocomplete } from "../hooks/useSkillAutocomplete";
import { removeImagePath } from "../utils/imageAttachments";
import BranchSelector, { parsePrUrl } from "./BranchSelector";
import SkillAutocompleteDropdown from "./SkillAutocompleteDropdown";
import { openFolderPicker } from "../folder-picker";
import { useFocusTrap } from "../utils/useFocusTrap";
import HelpSpot from "./HelpSpot";
import Select from "./Select";

interface ProjectCurrentBranchInfo {
	branch: string | null;
	isBaseBranch: boolean;
	isDirty: boolean;
}

interface CreateTaskModalProps {
	project: Project;
	projects?: Project[];
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	onCreateAndRun?: (task: Task, project: Project) => void;
	onOpenAutomations?: (project: Project) => void;
}

function CreateTaskModal({ project: initialProject, projects, dispatch, onClose, onCreateAndRun, onOpenAutomations }: CreateTaskModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const availableProjects = useMemo(() => {
		const visibleProjects = (projects ?? []).filter((candidate) => !candidate.deleted);
		if (!visibleProjects.some((candidate) => candidate.id === initialProject.id)) {
			visibleProjects.push(initialProject);
		}
		return orderProjectsForDisplay(visibleProjects);
	}, [initialProject, projects]);
	const [selectedProjectId, setSelectedProjectId] = useState(initialProject.id);
	const selectedProject = availableProjects.find((candidate) => candidate.id === selectedProjectId) ?? initialProject;
	const project = selectedProject;
	const [description, setDescription] = useState("");
	const [creating, setCreating] = useState(false);
	const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
	const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
	const [labelPickerOpen, setLabelPickerOpen] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [customTitle, setCustomTitle] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState(false);
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const [projectCurrentBranch, setProjectCurrentBranch] = useState<ProjectCurrentBranchInfo | null>(null);
	const [checkedProjectCurrentBranch, setCheckedProjectCurrentBranch] = useState(false);
	const [pendingBranchChoice, setPendingBranchChoice] = useState<string | null>(null);
	const [pendingSubmitMode, setPendingSubmitMode] = useState<"save" | "run" | "scratch" | null>(null);
	const [reviewMode, setReviewMode] = useState(false);
	const [dismissedPrUrl, setDismissedPrUrl] = useState<string | null>(null);
	const [prApplying, setPrApplying] = useState(false);
	const isVirtual = project.kind === "virtual";
	// Virtual ops only: chosen fixed working folder (null = managed temp dir).
	const [opsFolder, setOpsFolder] = useState<string | null>(null);
	const [opsFolderConflict, setOpsFolderConflict] = useState(false);
	const projectBranchRequestRef = useRef(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const keepEditingRef = useRef<HTMLButtonElement>(null);
	const labelAnchorRef = useRef<HTMLButtonElement>(null);
	const projectLabels = project.labels ?? [];
	const selectedLabels = projectLabels.filter((l) => selectedLabelIds.includes(l.id));
	const baseBranch = project.defaultBaseBranch || "main";

	const loadProjectCurrentBranch = useCallback(async (): Promise<ProjectCurrentBranchInfo | null> => {
		const requestId = ++projectBranchRequestRef.current;
		try {
			const result = await api.request.getProjectCurrentBranch({ projectId: project.id });
			if (requestId !== projectBranchRequestRef.current) return null;
			if (!result.isBaseBranch && result.branch) {
				setSelectedBranch((prev) => prev ?? result.branch);
			}
			setProjectCurrentBranch(result);
			return result;
		} catch {
			if (requestId !== projectBranchRequestRef.current) return null;
			setProjectCurrentBranch(null);
			return null;
		} finally {
			if (requestId === projectBranchRequestRef.current) {
				setCheckedProjectCurrentBranch(true);
			}
		}
	}, [project.id]);

	function handleProjectChange(projectId: string) {
		if (creating || projectId === selectedProjectId) return;
		projectBranchRequestRef.current += 1;
		setSelectedProjectId(projectId);
		setSelectedLabelIds([]);
		setLabelPickerOpen(false);
		setSelectedBranch(null);
		setProjectCurrentBranch(null);
		setCheckedProjectCurrentBranch(false);
		setPendingBranchChoice(null);
		setPendingSubmitMode(null);
		setDismissedPrUrl(null);
		setOpsFolder(null);
		setOpsFolderConflict(false);
		if (reviewMode) handleReviewModeChange(false);
	}

	const insertPathAtCursor = useCallback((path: string) => {
		setDescription((prev) => {
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

	const skillAutocomplete = useSkillAutocomplete(textareaRef, description, setDescription, project.path);

	const { handlePaste, isPasting, pasteKind } = useClipboardPaste(project.id, insertPathAtCursor);
	const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging } = useFileDrop(project.id, insertPathAtCursor);

	// Browser mode only: an explicit picker for devices without drag-and-drop
	// (phones/tablets). The Electrobun webview keeps paste + DnD; a file input
	// there would open an untested native chooser.
	const attachInputRef = useRef<HTMLInputElement>(null);
	const { uploading: attachUploading, attach } = useAttachUpload(project.id);
	const showAttachButton = !isElectrobun;

	function handleAttachPicked(e: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(e.target.files ?? []);
		// Reset so picking the same file again re-fires onChange.
		e.target.value = "";
		void attach(files).then((paths) => {
			paths.forEach(insertPathAtCursor);
		});
	}

	const handleRemovePath = useCallback((path: string) => {
		setDescription((prev) => removeImagePath(prev, path));
	}, []);

	const reviewPrompt = t("createTask.reviewPrompt");
	const REVIEW_SEPARATOR = "\n\n---\n\n";

	// Prompt + (optional) user text. Pure so the PR-apply path can compute the
	// final description synchronously without racing setState against a stale read.
	function buildReviewDescription(baseText: string): string {
		const userText = baseText.trim();
		return userText ? reviewPrompt + REVIEW_SEPARATOR + userText : reviewPrompt;
	}

	function handleReviewModeChange(enabled: boolean) {
		setReviewMode(enabled);
		if (enabled) {
			// Inject review prompt: if user has text, prepend prompt + separator + user text
			setDescription(buildReviewDescription(description));
		} else {
			// Remove review prompt: restore user's original text (if any)
			const current = description;
			const sepIdx = current.indexOf(REVIEW_SEPARATOR);
			if (current.startsWith(reviewPrompt) && sepIdx !== -1) {
				// Had user text after separator
				setDescription(current.slice(sepIdx + REVIEW_SEPARATOR.length));
			} else if (current.startsWith(reviewPrompt)) {
				// No user text — just the prompt
				setDescription("");
			}
			// If user modified the prompt text manually, leave it as-is
		}
	}

	// Opt-4 smart-paste: if a GitHub PR URL lands in the description, offer a
	// non-blocking affordance to turn it into a review task (resolve → select
	// branch → enable review mode). Hidden once a branch is chosen, review mode
	// is already on, this project has no git, or the user dismissed this URL.
	const detectedPr = parsePrUrl(description);
	const showPrBanner = !!detectedPr && detectedPr.url !== dismissedPrUrl && !selectedBranch && !reviewMode && !isVirtual;

	async function applyPrFromBanner() {
		if (!detectedPr || prApplying) return;
		setPrApplying(true);
		try {
			const result = await api.request.resolvePrUrl({ projectId: project.id, url: detectedPr.url });
			if (result.ok && result.branch) {
				// Strip the URL out of the description, then fold the remaining text
				// into the review prompt — the URL was the paste, not the task text.
				const cleaned = description.replace(detectedPr.url, "").replace(/\n{3,}/g, "\n\n").trim();
				setDescription(buildReviewDescription(cleaned));
				setReviewMode(true);
				setSelectedBranch(result.branch);
				setDismissedPrUrl(null);
			} else {
				toast.error(t("createTask.prResolveFailed", { error: result.error || "" }));
			}
		} catch (err) {
			toast.error(t("createTask.prResolveFailed", { error: String(err) }));
		} finally {
			setPrApplying(false);
		}
	}

	const generatedTitle = description.trim()
		? titleFromDescription(description)
		: "";

	useEffect(() => {
		textareaRef.current?.focus();
		// Virtual ops have no git branch — skip the branch lookup entirely.
		if (!isVirtual) void loadProjectCurrentBranch();
	}, [loadProjectCurrentBranch, isVirtual]);

	async function handlePickOpsFolder() {
		let folder: string | null;
		try {
			folder = await openFolderPicker({ initialPath: opsFolder });
		} catch {
			return;
		}
		if (!folder) return;
		setOpsFolder(folder);
		// Non-blocking warning: another ACTIVE op already using this folder.
		try {
			const all = await api.request.getAllProjectTasks();
			const mine = all.find((p) => p.projectId === project.id);
			const conflict = (mine?.tasks ?? []).some(
				(tk) => tk.worktreePath === folder && tk.status !== "completed" && tk.status !== "cancelled",
			);
			setOpsFolderConflict(conflict);
		} catch {
			setOpsFolderConflict(false);
		}
	}

	function handleRequestClose() {
		if (pendingBranchChoice) {
			setPendingBranchChoice(null);
			setPendingSubmitMode(null);
			return;
		}
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

	useEscapeKey(() => {
		if (skillAutocomplete.open) {
			skillAutocomplete.close();
		} else if (labelPickerOpen) {
			setLabelPickerOpen(false);
		} else if (pendingBranchChoice) {
			setPendingBranchChoice(null);
			setPendingSubmitMode(null);
		} else if (confirmDiscard) {
			setConfirmDiscard(false);
		} else {
			handleRequestClose();
		}
	});

	async function createTaskWithBranch(branch: string | null, mode: "save" | "run" | "scratch") {
		const trimmed = description.trim();
		if (mode !== "scratch" && !trimmed) return;
		if (creating) return;
		setCreating(true);
		try {
			const created = await api.request.createTask({
				projectId: project.id,
				// For scratch tasks the backend generates its own placeholder description —
				// we still send an empty string here to match the RPC shape.
				description: mode === "scratch" ? "" : trimmed,
				...(mode === "scratch" ? { scratch: true } : {}),
				...(branch ? { existingBranch: branch } : {}),
				...(isVirtual && opsFolder ? { opsWorkDir: opsFolder } : {}),
				...(priority !== DEFAULT_PRIORITY ? { priority } : {}),
			});
			// The task is now persisted on disk. Make it visible on the board
			// IMMEDIATELY — a task created into "todo" pushes no taskUpdated, so
			// if a follow-up (renameTask/setTaskLabels) fails, deferring the
			// dispatch would leave an invisible orphan and tempt a duplicate on
			// retry. Title/labels are non-fatal follow-ups on the created task.
			// A task created in another project must not be added to the board the
			// user is currently viewing; its persisted taskUpdated events will load
			// it when that project is opened.
			if (created.projectId === initialProject.id) {
				dispatch({ type: "addTask", task: created });
			}
			let task = created;
			let followUpError: unknown = null;
			try {
				if (customTitle) {
					task = await api.request.renameTask({
						taskId: created.id,
						projectId: project.id,
						customTitle,
					});
				}
				if (selectedLabelIds.length > 0) {
					task = await api.request.setTaskLabels({
						taskId: created.id,
						projectId: project.id,
						labelIds: selectedLabelIds,
					});
				}
				if (task !== created) {
					dispatch({ type: "updateTask", task });
				}
			} catch (followUpErr) {
				followUpError = followUpErr;
			}
			if (followUpError) {
				toast.error(t("kanban.createdButFollowUpFailed", { error: String(followUpError) }));
			}
			trackEvent("task_created", {
				project_id: project.id,
				...(mode === "run" ? { source: "create_and_run" } : {}),
				...(mode === "scratch" ? { source: "scratch" } : {}),
			});
			if ((mode === "run" || mode === "scratch") && onCreateAndRun) {
				onCreateAndRun(task, project);
			} else {
				onClose();
			}
		} catch (err) {
			toast.error(t("kanban.failedCreate", { error: String(err) }));
			setCreating(false);
		}
	}

	async function handleSubmit(mode: "save" | "run" | "scratch") {
		const trimmed = description.trim();
		if (creating) return;
		if (mode !== "scratch" && !trimmed) return;
		if (mode === "run" && !onCreateAndRun) return;
		if (mode === "scratch" && !onCreateAndRun) return;

		// Virtual ops have no git branch — create directly with no branch choice.
		if (isVirtual) {
			await createTaskWithBranch(null, mode);
			return;
		}

		// Race guard: if the initial getProjectCurrentBranch() lookup is still
		// in-flight when the user clicks Save, the user has not yet had a
		// chance to see the auto-fill or to clear/change the picker. In that
		// case, treat the just-loaded non-base branch as the effective
		// selection — otherwise the stale null `selectedBranch` from the
		// pre-auto-fill render would cause the branch-choice confirmation to
		// be silently skipped on a fast first Save click.
		const wasAlreadyChecked = checkedProjectCurrentBranch;
		const branchInfo = wasAlreadyChecked ? projectCurrentBranch : await loadProjectCurrentBranch();
		const effectiveBranch =
			!wasAlreadyChecked && branchInfo && !branchInfo.isBaseBranch && branchInfo.branch
				? branchInfo.branch
				: selectedBranch;

		if (
			effectiveBranch
			&& branchInfo?.branch
			&& !branchInfo.isBaseBranch
			&& effectiveBranch === branchInfo.branch
		) {
			setPendingBranchChoice(branchInfo.branch);
			setPendingSubmitMode(mode);
			return;
		}

		await createTaskWithBranch(effectiveBranch, mode);
	}

	async function handleCreate() {
		await handleSubmit("save");
	}

	async function handleCreateAndRun() {
		await handleSubmit("run");
	}

	async function handleCreateScratch() {
		await handleSubmit("scratch");
	}

	function dismissBranchChoice() {
		setPendingBranchChoice(null);
		setPendingSubmitMode(null);
	}

	function handleBranchChoice(branch: string | null) {
		const mode = pendingSubmitMode;
		dismissBranchChoice();
		if (!mode) return;
		void createTaskWithBranch(branch, mode);
	}

	function toggleLabelId(labelId: string) {
		setSelectedLabelIds((prev) =>
			prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId],
		);
	}

	return (
		<div
			data-create-task-modal="true"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={handleRequestClose}
		>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
			<div ref={trapRef} role="dialog" aria-modal="true" tabIndex={-1} data-help-id="modal.create-task" className="relative bg-overlay border border-edge rounded-2xl shadow-2xl w-[32.5rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6 space-y-5 outline-none" onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1.5">
						<h2 className="text-fg text-lg font-semibold">
							{t("createTask.title")}
						</h2>
						<HelpSpot topicId="modal.create-task" />
					</div>
					<button
						onClick={handleRequestClose}
						className="text-fg-muted hover:text-fg transition-colors p-1 -mr-1 rounded-lg hover:bg-fg/5"
						aria-label="Close"
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Project context — defaults to the board that opened this modal. */}
				<div className="space-y-1.5">
					<label htmlFor="create-task-project" className="text-fg-2 text-sm font-medium">
						{t("createTask.projectLabel")}
					</label>
					<Select
						id="create-task-project"
						value={project.id}
						options={availableProjects.map((candidate) => ({
							value: candidate.id,
							label: isBuiltinOpsProject(candidate) ? t("ops.boardName") : candidate.name,
						}))}
						onChange={handleProjectChange}
					/>
				</div>

				{/* Description textarea + drop zone */}
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<label className="text-fg-2 text-sm font-medium">
							{t("createTask.descriptionLabel")}
						</label>
						{showAttachButton && (
							<>
								<input
									ref={attachInputRef}
									type="file"
									multiple
									className="hidden"
									onChange={handleAttachPicked}
									data-testid="create-task-attach-input"
								/>
								<button
									type="button"
									onClick={() => attachInputRef.current?.click()}
									disabled={attachUploading}
									aria-label={t("images.attachFiles")}
									title={t("images.attachFiles")}
									className="flex items-center justify-center w-7 h-7 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
									data-testid="create-task-attach"
								>
									{attachUploading ? (
										<div className="w-3.5 h-3.5 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
									) : (
										<span
											className="text-[1rem] leading-none"
											style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										>
											{"\u{F03E2}"}
										</span>
									)}
								</button>
							</>
						)}
					</div>

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
							onChange={(e) => {
								setDescription(e.target.value);
								skillAutocomplete.sync();
							}}
							onSelect={skillAutocomplete.sync}
							onKeyDown={(e) => {
								if (skillAutocomplete.handleKeyDown(e)) return;
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
						{skillAutocomplete.open && (
							<SkillAutocompleteDropdown
								items={skillAutocomplete.items}
								activeIndex={skillAutocomplete.activeIndex}
								onHover={skillAutocomplete.setActiveIndex}
								onSelect={skillAutocomplete.accept}
								invocationPrefix={skillAutocomplete.invocationPrefix}
							/>
						)}
					</div>
					{isPasting && (
						<span className="text-[0.6875rem] text-accent animate-pulse">{t(pasteKind === "text" ? "paste.savingText" : "images.pasting")}</span>
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

				{showPrBanner && detectedPr && (
					<div className="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2.5">
						<span
							className="text-accent text-[1.0625rem] leading-none mt-0.5 shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\uf407"}
						</span>
						<div className="flex-1 min-w-0">
							<p className="text-sm text-fg-2">
								{t("createTask.prBannerText", { number: String(detectedPr.number) })}
							</p>
							<div className="mt-1.5 flex items-center gap-2">
								<button
									type="button"
									onClick={applyPrFromBanner}
									disabled={prApplying}
									className="px-2.5 py-1 rounded-lg border border-accent/40 bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
								>
									{prApplying ? t("createTask.prResolving") : t("createTask.prBannerSetup")}
								</button>
								<button
									type="button"
									onClick={() => setDismissedPrUrl(detectedPr.url)}
									className="text-fg-muted text-xs hover:text-fg-3 transition-colors"
								>
									{t("createTask.prBannerKeep")}
								</button>
							</div>
						</div>
					</div>
				)}

				{/* Priority selector — compact badge + picker, defaults to P3. */}
				<div className="flex items-center gap-2">
					<label className="text-fg-2 text-sm font-medium">
						{t("priority.label")}
					</label>
					<PriorityBadge priority={priority} onChange={setPriority} size="sm" />
				</div>

				{/* Label selector — compact: only the selected labels show as chips;
				    the picker popover (search / toggle / inline-create) owns the full list. */}
				<div className="space-y-2">
					<label className="text-fg-2 text-sm font-medium">
						{t("labels.taskLabels")}
					</label>
					<div className="flex flex-wrap items-center gap-1.5">
						{selectedLabels.map((label) => (
							<LabelChip
								key={label.id}
								label={label}
								size="sm"
								active
								onRemove={(e) => {
									e.stopPropagation();
									toggleLabelId(label.id);
								}}
							/>
						))}
						<button
							ref={labelAnchorRef}
							type="button"
							onClick={() => setLabelPickerOpen(true)}
							className="inline-flex items-center rounded-full border border-dashed border-edge-active px-2 py-0.5 text-[0.625rem] font-medium text-fg-3 hover:text-fg hover:bg-fg/5 transition-colors"
							title={t("labels.addLabel")}
						>
							{t("labels.addLabel")}
						</button>
						{labelPickerOpen && labelAnchorRef.current && (
							<LabelPicker
								project={project}
								dispatch={dispatch}
								onClose={() => setLabelPickerOpen(false)}
								anchorEl={labelAnchorRef.current}
								selectedIds={selectedLabelIds}
								onToggle={toggleLabelId}
							/>
						)}
					</div>
				</div>

				{/* Virtual ops: working-folder selector (managed temp dir by default). */}
				{isVirtual ? (
					<div className="space-y-1.5">
						<label className="text-fg-2 text-sm font-medium">{t("ops.create.workDirLabel")}</label>
						<div className="flex gap-2">
							<div className="flex-1 px-3 py-2 bg-raised border border-edge rounded-xl text-sm truncate">
								{opsFolder ? (
									<span className="text-fg font-mono">{opsFolder}</span>
								) : (
									<span className="text-fg-3">{t("ops.create.workDirAuto")}</span>
								)}
							</div>
							{opsFolder && (
								<button
									type="button"
									onClick={() => { setOpsFolder(null); setOpsFolderConflict(false); }}
									className="px-3 py-2 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active transition-colors flex-shrink-0"
								>
									{t("ops.create.workDirReset")}
								</button>
							)}
							<button
								type="button"
								onClick={handlePickOpsFolder}
								className="px-3 py-2 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active transition-colors flex-shrink-0"
							>
								{t("ops.create.workDirPick")}
							</button>
						</div>
						{opsFolderConflict && (
							<p className="text-xs text-amber-500">{t("ops.create.workDirConflict")}</p>
						)}
					</div>
				) : (
					/* Branch selector — collapsible */
					<BranchSelector
						projectId={project.id}
						selectedBranch={selectedBranch}
						onSelectBranch={(branch) => {
							setSelectedBranch(branch);
							// Turn off review mode when branch is deselected
							if (!branch && reviewMode) {
								handleReviewModeChange(false);
							}
						}}
						reviewMode={reviewMode}
						onReviewModeChange={handleReviewModeChange}
					/>
				)}

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
							<div className="flex flex-wrap items-center justify-end gap-2">
								{onCreateAndRun && (
									<div className="mr-auto flex flex-col items-start gap-0.5">
										<button
											onClick={handleCreateScratch}
											disabled={creating}
											title={t("createTask.scratchHint")}
											className="px-3 py-1.5 bg-elevated border border-edge-active text-fg-2 text-xs font-medium rounded-lg hover:bg-elevated-hover hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
										>
											<span
												className="text-[0.875rem] leading-none"
												style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
											>
												{"\u{F018D}"}
											</span>
											{t("createTask.scratch")}
										</button>
										<span className="text-fg-muted text-[0.6875rem] leading-tight">
											{t("createTask.scratchSubtitle")}
										</span>
									</div>
								)}
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
							<div className="flex flex-wrap items-center justify-between gap-2 text-[0.6875rem]">
								{onOpenAutomations ? (
									<button
										type="button"
										onClick={() => onOpenAutomations(project)}
										className="text-accent hover:text-accent-hover hover:underline transition-colors flex items-center gap-1"
									>
										<span
											className="text-[0.8125rem] leading-none"
											style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										>
											{"\u{F0150}"}
										</span>
										{t("automations.newTaskLink")}
									</button>
								) : (
									<span />
								)}
								<div className="text-fg-muted text-right">
									{onCreateAndRun
										? t("createTask.submitHintRun")
										: t("createTask.submitHint")}
								</div>
							</div>
						</>
					)}
				</div>
				{pendingBranchChoice && (
					<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
						<div className="w-full max-w-md rounded-2xl border border-edge bg-overlay p-5 shadow-2xl space-y-4">
							<div className="space-y-2">
								<h3 className="text-fg text-base font-semibold">
									{t("createTask.branchChoiceTitle")}
								</h3>
								<p className="text-fg-2 text-sm">
									{t("createTask.branchChoiceBody", {
										currentBranch: pendingBranchChoice,
										baseBranch,
									})}
								</p>
								<p className="text-fg-3 text-sm">
									{t("createTask.branchChoiceBaseHint", {
										baseBranch,
										baseRef: `origin/${baseBranch}`,
									})}
								</p>
								<p className="text-fg-3 text-sm">
									{t("createTask.branchChoiceRisk")}
								</p>
								{projectCurrentBranch?.isDirty && (
									<p className="text-danger text-sm">
										{t("createTask.branchChoiceDirty")}
									</p>
								)}
							</div>
							<div className="flex flex-wrap justify-end gap-2">
								<button
									type="button"
									onClick={dismissBranchChoice}
									className="px-3 py-1.5 text-fg-3 text-sm hover:text-fg transition-colors rounded-lg"
								>
									{t("createTask.keepEditing")}
								</button>
								<button
									type="button"
									onClick={() => handleBranchChoice(null)}
									className="px-3 py-1.5 bg-elevated border border-edge-active text-fg text-sm font-medium rounded-lg hover:bg-elevated-hover transition-colors"
								>
									{t("createTask.branchChoiceBase", { baseBranch })}
								</button>
								<button
									type="button"
									onClick={() => handleBranchChoice(pendingBranchChoice)}
									className="px-3 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover transition-colors"
								>
									{t("createTask.branchChoiceCurrent", { currentBranch: pendingBranchChoice })}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default CreateTaskModal;
