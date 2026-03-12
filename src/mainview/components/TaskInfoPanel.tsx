import { useState, useRef, useCallback, useEffect, useLayoutEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Task, Project, TaskStatus, BranchStatus, PortInfo } from "../../shared/types";
import LabelChip from "./LabelChip";
import { NoteItem, formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import InlineRename from "./InlineRename";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { trackEvent } from "../analytics";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import OpenInMenu from "./OpenInMenu";
import MiniPipeline from "./MiniPipeline";
import PipelineDropdown from "./PipelineDropdown";
import SpawnAgentModal from "./SpawnAgentModal";

interface TaskInfoPanelProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	taskPorts?: Map<string, PortInfo[]>;
	isFullPage?: boolean;
}

const COLLAPSED_HEIGHT_REM = 3.875; // 62px at 1× zoom – scales with root font-size
const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 80;
const MAX_RATIO = 0.33;

const LS_COLLAPSED = "dev3-panel-collapsed";
const LS_HEIGHT = "dev3-panel-height";

function readBool(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		if (v === "true") return true;
		if (v === "false") return false;
	} catch {}
	return fallback;
}

function readNumber(key: string, fallback: number): number {
	try {
		const v = localStorage.getItem(key);
		if (v !== null) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	} catch {}
	return fallback;
}


interface DevServerMenuProps {
	position: { top: number; left: number };
	onRestart: () => void;
	onStop: () => void;
	onClose: () => void;
	t: ReturnType<typeof useT>;
}

function DevServerMenu({ position, onRestart, onStop, onClose, t }: DevServerMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState(position);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [onClose]);

	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const menu = menuRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;
		let top = position.top;
		let left = position.left;
		if (top + menu.height > vh - pad) top = vh - menu.height - pad;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setMenuPos({ top, left });
		setVisible(true);
	}, [position]);

	return (
		<div
			ref={menuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
			style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("header.devServerRunning")}
			</div>
			<button
				onClick={onRestart}
				className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
			>
				<svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
						d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
				{t("header.devServerRestart")}
			</button>
			<button
				onClick={onStop}
				className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-elevated-hover flex items-center gap-2.5 transition-colors"
			>
				<svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
					<rect x="5" y="5" width="14" height="14" rx="2" />
				</svg>
				{t("header.devServerStop")}
			</button>
		</div>
	);
}

function TaskInfoPanel({ task, project, dispatch, navigate, taskPorts, isFullPage }: TaskInfoPanelProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(() => readBool(LS_COLLAPSED, true));
	const [panelHeight, setPanelHeight] = useState(() => readNumber(LS_HEIGHT, DEFAULT_HEIGHT));

	const panelRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// ---- Status dropdown state ----
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [statusMenuPos, setStatusMenuPos] = useState({ top: 0, left: 0 });
	const [statusMenuVisible, setStatusMenuVisible] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const statusTriggerRef = useRef<HTMLButtonElement>(null);
	const statusMenuRef = useRef<HTMLDivElement>(null);

	// Close status menu on click outside
	useEffect(() => {
		if (!statusMenuOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				statusMenuRef.current &&
				!statusMenuRef.current.contains(e.target as Node) &&
				statusTriggerRef.current &&
				!statusTriggerRef.current.contains(e.target as Node)
			) {
				setStatusMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [statusMenuOpen]);

	// Smart viewport clamping for status menu
	useLayoutEffect(() => {
		if (!statusMenuOpen || !statusMenuRef.current || !statusTriggerRef.current) return;

		const menu = statusMenuRef.current.getBoundingClientRect();
		const trigger = statusTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setStatusMenuPos({ top, left });
		setStatusMenuVisible(true);
	}, [statusMenuOpen]);

	function toggleStatusMenu(e: React.MouseEvent) {
		e.stopPropagation();
		if (!statusMenuOpen && statusTriggerRef.current) {
			const rect = statusTriggerRef.current.getBoundingClientRect();
			setStatusMenuPos({ top: rect.bottom + 6, left: rect.left });
			setStatusMenuVisible(false);
		}
		setStatusMenuOpen(!statusMenuOpen);
	}

	async function handleStatusMove(newStatus: TaskStatus) {
		// Warn before completing/cancelling with unpushed changes
		if (
			task.worktreePath &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			setStatusMenuOpen(false);
			const proceed = await confirmTaskCompletion(task, project, newStatus, t);
			if (!proceed) return;
		}

		const fromStatus = task.status;
		setMovingStatus(true);
		setStatusMenuOpen(false);

		// completed/cancelled: navigate immediately, cleanup in background
		if (newStatus === "completed" || newStatus === "cancelled") {
			dispatch({ type: "updateTask", task: { ...task, status: newStatus, worktreePath: null, branchName: null, movedAt: new Date().toISOString(), columnOrder: undefined } });
			dispatch({ type: "clearBell", taskId: task.id });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			navigate({ screen: "project", projectId: project.id });
			api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			}).catch(() => {
				api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				}).catch((err) => console.error("Background moveTask failed:", err));
			});
			return;
		}

		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			if (!ACTIVE_STATUSES.includes(newStatus)) {
				navigate({ screen: "project", projectId: project.id });
			}
		} catch (err) {
			// Auto-retry with force — environment is likely broken
			try {
				const updated = await api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				});
				dispatch({ type: "updateTask", task: updated });
				trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
				if (!ACTIVE_STATUSES.includes(newStatus)) {
					navigate({ screen: "project", projectId: project.id });
				}
			} catch (retryErr) {
				alert(t("task.failedMove", { error: String(retryErr) }));
			}
		}
		setMovingStatus(false);
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
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}` });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
		setMovingStatus(false);
	}

	// ---- Tmux hints popover state ----
	const [hintsOpen, setHintsOpen] = useState(false);
	const [hintsPos, setHintsPos] = useState({ top: 0, left: 0 });
	const [hintsVisible, setHintsVisible] = useState(false);
	const hintsTriggerRef = useRef<HTMLDivElement>(null);
	const hintsPopoverRef = useRef<HTMLDivElement>(null);
	const hintsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	function clearHintsTimeout() {
		if (hintsTimeoutRef.current) {
			clearTimeout(hintsTimeoutRef.current);
			hintsTimeoutRef.current = null;
		}
	}

	function showHints() {
		clearHintsTimeout();
		if (!hintsOpen) {
			if (hintsTriggerRef.current) {
				const rect = hintsTriggerRef.current.getBoundingClientRect();
				setHintsPos({ top: rect.bottom + 6, left: rect.right });
				setHintsVisible(false);
			}
			setHintsOpen(true);
		}
	}

	function hideHints() {
		clearHintsTimeout();
		hintsTimeoutRef.current = setTimeout(() => {
			setHintsOpen(false);
			setHintsVisible(false);
		}, 200);
	}

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => clearHintsTimeout();
	}, []);

	// Escape key closes hints
	useEffect(() => {
		if (!hintsOpen) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				setHintsOpen(false);
				setHintsVisible(false);
			}
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [hintsOpen]);

	// Viewport clamping for hints popover
	useLayoutEffect(() => {
		if (!hintsOpen || !hintsPopoverRef.current || !hintsTriggerRef.current) return;

		const menu = hintsPopoverRef.current.getBoundingClientRect();
		const trigger = hintsTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.right - menu.width;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setHintsPos({ top, left });
		setHintsVisible(true);
	}, [hintsOpen]);

	// ---- Spawn Agent ----
	const [spawnModalOpen, setSpawnModalOpen] = useState(false);

	// ---- Dev server ----
	const hasDevScript = !!(project.devScript?.trim());
	const isTaskActive = ACTIVE_STATUSES.includes(task.status);
	const devServerDisabled = !hasDevScript || !isTaskActive;
	const devServerBtnRef = useRef<HTMLButtonElement>(null);
	const [devServerMenuOpen, setDevServerMenuOpen] = useState(false);
	const [devServerMenuPos, setDevServerMenuPos] = useState({ top: 0, left: 0 });

	async function handleDevServer() {
		if (devServerDisabled) return;
		try {
			const { running } = await api.request.checkDevServer({ taskId: task.id, projectId: project.id });
			if (running) {
				if (devServerBtnRef.current) {
					const rect = devServerBtnRef.current.getBoundingClientRect();
					setDevServerMenuPos({ top: rect.bottom + 4, left: rect.left });
				}
				setDevServerMenuOpen(true);
			} else {
				await api.request.runDevServer({ taskId: task.id, projectId: project.id });
			}
		} catch (err) {
			alert(t("infoPanel.devServerFailed", { error: String(err) }));
		}
	}

	async function handleDevServerRestart() {
		setDevServerMenuOpen(false);
		try {
			await api.request.runDevServer({ taskId: task.id, projectId: project.id });
		} catch (err) {
			alert(t("infoPanel.devServerFailed", { error: String(err) }));
		}
	}

	async function handleDevServerStop() {
		setDevServerMenuOpen(false);
		try {
			await api.request.stopDevServer({ taskId: task.id, projectId: project.id });
		} catch (err) {
			alert(t("infoPanel.devServerFailed", { error: String(err) }));
		}
	}

	// ---- Branch status polling ----
	const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
	const [rebasing, setRebasing] = useState(false);
	const [merging, setMerging] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [creatingPR, setCreatingPR] = useState(false);
	const [refreshingStatus, setRefreshingStatus] = useState(false);
	const pushThenCreatePRRef = useRef(false);
	const mergeDialogShownRef = useRef(false);
	const [compareRef, setCompareRef] = useState<string>(""); // "" = origin/<baseBranch> (default)
	const [refMenuOpen, setRefMenuOpen] = useState(false);
	const [refMenuPos, setRefMenuPos] = useState({ top: 0, left: 0 });
	const refTriggerRef = useRef<HTMLButtonElement>(null);
	const refMenuRef = useRef<HTMLDivElement>(null);
	const fetchStatusRef = useRef<(() => Promise<void>) | null>(null);
	const [diffFilesHover, setDiffFilesHover] = useState(false);
	const [diffFilesPos, setDiffFilesPos] = useState({ top: 0, left: 0 });
	const diffFilesTriggerRef = useRef<HTMLSpanElement>(null);
	const diffFilesHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isTaskActive || !task.worktreePath) return;

		// Reset merge dialog flag when task changes
		mergeDialogShownRef.current = false;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		async function fetchStatus() {
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				if (!cancelled) {
					setBranchStatus(status);
					// Show merge-detected dialog immediately when branch is merged
					if (
						status.mergedByContent &&
						task.status === "review-by-user" &&
						!mergeDialogShownRef.current
					) {
						mergeDialogShownRef.current = true;
						const shouldComplete = await api.request.showConfirm({
							title: t("app.branchMergedTitle"),
							message: t("app.branchMergedMessage", {
								taskTitle: task.customTitle || task.title,
								branchName: task.branchName || "",
							}),
						});
						if (shouldComplete) {
							dispatch({ type: "updateTask", task: { ...task, status: "completed", worktreePath: null, branchName: null, movedAt: new Date().toISOString(), columnOrder: undefined } });
							dispatch({ type: "clearBell", taskId: task.id });
							trackEvent("task_moved", { from_status: "review-by-user", to_status: "completed" });
							navigate({ screen: "project", projectId: project.id });
							api.request.moveTask({
								taskId: task.id,
								projectId: project.id,
								newStatus: "completed",
							}).catch(() => {
								api.request.moveTask({
									taskId: task.id,
									projectId: project.id,
									newStatus: "completed",
									force: true,
								}).catch((err) => console.error("moveTask (merge-detected) failed:", err));
							});
						}
					}
				}
			} catch (err) {
				// Silently ignore — polling will retry
			}
			// Schedule next poll AFTER this one completes — prevents stampede
			// on app wake/reconnect (setInterval fires all missed ticks at once).
			if (!cancelled) {
				timer = setTimeout(fetchStatus, 15_000);
			}
		}

		fetchStatusRef.current = fetchStatus;
		fetchStatus();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [task.id, project.id, isTaskActive, task.worktreePath, compareRef]);

	async function handleRefreshStatus() {
		if (refreshingStatus || !fetchStatusRef.current) return;
		setRefreshingStatus(true);
		await fetchStatusRef.current();
		setRefreshingStatus(false);
	}

	async function handleRebase() {
		if (rebasing) return;
		setRebasing(true);
		try {
			await api.request.rebaseTask({
				taskId: task.id,
				projectId: project.id,
				compareRef: compareRef || undefined,
			});
		} catch (err) {
			alert(t("infoPanel.rebaseFailed", { error: String(err) }));
		}
		setRebasing(false);
	}

	async function handleMerge() {
		if (merging) return;
		setMerging(true);
		try {
			await api.request.mergeTask({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			alert(t("infoPanel.mergeFailed", { error: String(err) }));
		}
		setMerging(false);
	}

	async function handlePush() {
		if (pushing) return;
		setPushing(true);
		try {
			await api.request.pushTask({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			alert(t("infoPanel.pushFailed", { error: String(err) }));
		}
		setPushing(false);
	}

	async function handleCreatePR() {
		if (creatingPR) return;
		setCreatingPR(true);
		try {
			await api.request.createPullRequest({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			alert(t("infoPanel.createPRFailed", { error: String(err) }));
		}
		setCreatingPR(false);
	}

	async function handleShowDiff() {
		try {
			await api.request.showDiff({
				taskId: task.id,
				projectId: project.id,
				compareRef: compareRef || undefined,
			});
		} catch (err) {
			alert(t("infoPanel.showDiffFailed", { error: String(err) }));
		}
	}

	async function handleShowUncommittedDiff() {
		try {
			await api.request.showUncommittedDiff({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			alert(t("infoPanel.uncommittedDiffFailed", { error: String(err) }));
		}
	}

	// Listen for git operation completion — refresh branch status and handle post-merge dialog
	useEffect(() => {
		async function onGitOpCompleted(e: Event) {
			const detail = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				operation: string;
				ok: boolean;
			};
			if (detail.taskId !== task.id) return;

			// Refresh branch status
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				setBranchStatus(status);
			} catch { /* silently ignore */ }

			// Post-push: auto-create PR if triggered by "Push & Create PR"
			if (detail.operation === "push" && detail.ok && pushThenCreatePRRef.current) {
				pushThenCreatePRRef.current = false;
				setPushing(false);
				handleCreatePR();
			}

			// Post-merge: show "complete task?" dialog
			if (detail.operation === "merge" && detail.ok) {
				const shouldComplete = await api.request.showConfirm({
					title: t("infoPanel.mergeComplete"),
					message: t("infoPanel.mergeCompleteMessage"),
				});
				if (shouldComplete) {
					const fromStatus = task.status;
					dispatch({ type: "updateTask", task: { ...task, status: "completed", worktreePath: null, branchName: null, movedAt: new Date().toISOString(), columnOrder: undefined } });
					dispatch({ type: "clearBell", taskId: task.id });
					trackEvent("task_moved", { from_status: fromStatus, to_status: "completed" });
					navigate({ screen: "project", projectId: project.id });
					api.request.moveTask({
						taskId: task.id,
						projectId: project.id,
						newStatus: "completed",
					}).catch(() => {
						api.request.moveTask({
							taskId: task.id,
							projectId: project.id,
							newStatus: "completed",
							force: true,
						}).catch((err) => console.error("Background moveTask (post-merge) failed:", err));
					});
				}
			}
		}

		window.addEventListener("rpc:gitOpCompleted", onGitOpCompleted);
		return () => window.removeEventListener("rpc:gitOpCompleted", onGitOpCompleted);
	}, [task.id, project.id, dispatch, navigate, t]);

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

	// ---- Panel collapse / drag ----

	// Persist collapsed
	useEffect(() => {
		try { localStorage.setItem(LS_COLLAPSED, String(collapsed)); } catch {}
	}, [collapsed]);

	// Persist height
	useEffect(() => {
		try { localStorage.setItem(LS_HEIGHT, String(panelHeight)); } catch {}
	}, [panelHeight]);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((c) => !c);
	}, []);

	const onDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			if (collapsed) return;

			dragging.current = true;
			const startY = e.clientY;
			const startH = panelRef.current?.offsetHeight ?? panelHeight;
			const el = panelRef.current;

			if (el) el.style.transition = "none";

			function onMove(ev: MouseEvent) {
				if (!dragging.current) return;
				const maxH = window.innerHeight * MAX_RATIO;
				const newH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)));
				if (el) el.style.height = `${newH}px`;
			}

			function onUp(ev: MouseEvent) {
				dragging.current = false;
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);

				if (el) {
					el.style.transition = "";
					const maxH = window.innerHeight * MAX_RATIO;
					const finalH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)));
					setPanelHeight(finalH);
				}
			}

			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		},
		[collapsed, panelHeight],
	);

	const onHandleDoubleClick = useCallback(() => {
		setCollapsed((c) => !c);
	}, []);

	// ---- Shared elements ----

	const height = collapsed ? `${COLLAPSED_HEIGHT_REM}rem` : panelHeight;

	const statusDropdownButton = (
		<button
			ref={statusTriggerRef}
			onClick={toggleStatusMenu}
			disabled={movingStatus}
			className="flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-elevated transition-colors flex-shrink-0"
		>
			<MiniPipeline status={task.status} />
			<span className="text-[0.6875rem] font-medium text-fg-2">
				{t(statusKey(task.status))}
			</span>
			<svg className="w-3 h-3 text-fg-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
			</svg>
		</button>
	);

	const statusDropdownPortal = statusMenuOpen && createPortal(
		<div
			ref={statusMenuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
			style={{
				top: statusMenuPos.top,
				left: statusMenuPos.left,
				visibility: statusMenuVisible ? "visible" : "hidden",
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<PipelineDropdown
				currentStatus={task.status}
				onMove={handleStatusMove}
				onMoveToCustomColumn={handleMoveToCustomColumn}
				customColumns={project.customColumns}
				currentCustomColumnId={task.customColumnId}
			/>
		</div>,
		document.body,
	);

	const branchStatusLoading = isTaskActive && task.worktreePath && !branchStatus ? (
		<span className="flex items-center gap-1 text-[0.6875rem] text-fg-muted flex-shrink-0">
			<svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
				<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
			</svg>
		</span>
	) : null;

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const displayRef = compareRef || `origin/${baseBranch}`;

	// Close ref menu on click outside
	useEffect(() => {
		if (!refMenuOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				refMenuRef.current && !refMenuRef.current.contains(e.target as Node) &&
				refTriggerRef.current && !refTriggerRef.current.contains(e.target as Node)
			) {
				setRefMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [refMenuOpen]);

	function handleRefSelect(ref: string) {
		setCompareRef(ref);
		setRefMenuOpen(false);
		setBranchStatus(null); // clear stale data while re-fetching
	}

	function showDiffFilesPopover() {
		if (diffFilesHoverTimer.current) clearTimeout(diffFilesHoverTimer.current);
		if (diffFilesTriggerRef.current) {
			const rect = diffFilesTriggerRef.current.getBoundingClientRect();
			setDiffFilesPos({ top: rect.bottom + 4, left: rect.left });
		}
		setDiffFilesHover(true);
	}
	function hideDiffFilesPopover() {
		diffFilesHoverTimer.current = setTimeout(() => setDiffFilesHover(false), 150);
	}
	function cancelHideDiffFiles() {
		if (diffFilesHoverTimer.current) clearTimeout(diffFilesHoverTimer.current);
	}

	const diffStatsBadge = branchStatus && (branchStatus.diffFiles > 0) ? (
		<span
			ref={diffFilesTriggerRef}
			className="flex items-center gap-1.5 text-[0.6875rem] text-fg-3 flex-shrink-0 font-mono cursor-default"
			onMouseEnter={showDiffFilesPopover}
			onMouseLeave={hideDiffFilesPopover}
		>
			<span className="text-fg-muted text-[0.8rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0CB"}</span>
			<span>{branchStatus.diffFiles} {branchStatus.diffFiles === 1 ? "file" : "files"}</span>
			<span className="text-[#34d399]">+{branchStatus.diffInsertions}</span>
			<span className="text-[#f87171]">−{branchStatus.diffDeletions}</span>
		</span>
	) : null;

	// "Open file in..." state for diff files popover
	const [fileOpenInMenu, setFileOpenInMenu] = useState<{ path: string; pos: { top: number; left: number } } | null>(null);

	function handleFileOpenIn(e: React.MouseEvent, relativePath: string) {
		e.stopPropagation();
		if (!task.worktreePath) return;
		const fullPath = `${task.worktreePath}/${relativePath}`;
		setFileOpenInMenu({ path: fullPath, pos: { top: e.clientY, left: e.clientX } });
	}

	const diffFilesPopover = diffFilesHover && branchStatus && branchStatus.diffFileNames.length > 0 && createPortal(
		<div
			className="fixed bg-overlay border border-edge-active rounded-lg shadow-2xl shadow-black/40 py-2 px-3 max-w-[25rem] max-h-[20rem] overflow-auto"
			style={{ top: diffFilesPos.top, left: diffFilesPos.left, zIndex: 9999 }}
			onMouseEnter={cancelHideDiffFiles}
			onMouseLeave={hideDiffFilesPopover}
		>
			<div className="text-[0.625rem] text-fg-muted font-semibold uppercase tracking-wider mb-1.5">Changed files</div>
			{branchStatus.diffFileNames.map((f) => (
				<div
					key={f}
					className="group/file flex items-center gap-1.5 py-0.5 leading-snug"
				>
					<span className="text-[0.6875rem] text-fg-2 font-mono truncate flex-1">{f}</span>
					<button
						onClick={(e) => handleFileOpenIn(e, f)}
						className="opacity-0 group-hover/file:opacity-100 text-[0.5625rem] text-accent hover:text-accent-hover transition-all px-1 py-0.5 rounded bg-accent/10 hover:bg-accent/20 flex-shrink-0"
						title={t("openIn.menuTitle")}
					>
						<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
					</button>
				</div>
			))}
		</div>,
		document.body,
	);

	const fileOpenInMenuPortal = fileOpenInMenu && (
		<OpenInMenu
			position={fileOpenInMenu.pos}
			path={fileOpenInMenu.path}
			onClose={() => setFileOpenInMenu(null)}
		/>
	);

	const uncommittedBadge = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0) ? (
		<span className="flex items-center gap-1 text-[0.6875rem] font-medium text-danger flex-shrink-0">
			<span>+{branchStatus.insertions}</span>
			<span>/</span>
			<span>−{branchStatus.deletions}</span>
		</span>
	) : null;

	const refOptions = [
		{ value: "", label: `origin/${baseBranch}` },
		{ value: baseBranch, label: `${baseBranch} (local)` },
	];

	const refDropdownButton = branchStatus ? (
		<button
			ref={refTriggerRef}
			onClick={(e) => {
				e.stopPropagation();
				if (!refMenuOpen && refTriggerRef.current) {
					const rect = refTriggerRef.current.getBoundingClientRect();
					setRefMenuPos({ top: rect.bottom + 4, left: rect.left });
				}
				setRefMenuOpen(!refMenuOpen);
			}}
			className="text-[0.6875rem] text-accent font-normal hover:text-accent-hover transition-colors cursor-pointer flex-shrink-0"
			title="Change comparison branch"
		>
			vs {displayRef} ▾
		</button>
	) : null;

	const refDropdownPortal = refMenuOpen && createPortal(
		<div
			ref={refMenuRef}
			className="fixed bg-overlay border border-edge-active rounded-md shadow-2xl shadow-black/40 py-1 min-w-[10rem]"
			style={{ top: refMenuPos.top, left: refMenuPos.left, zIndex: 9999 }}
			onClick={(e) => e.stopPropagation()}
		>
			{refOptions.map((opt) => (
				<button
					key={opt.value}
					onClick={(e) => { e.stopPropagation(); handleRefSelect(opt.value); }}
					className={`block w-full text-left px-3 py-1.5 text-[0.6875rem] hover:bg-elevated-hover transition-colors cursor-pointer ${
						compareRef === opt.value ? "text-accent font-medium" : "text-fg-2"
					}`}
				>
					{opt.label}
				</button>
			))}
		</div>,
		document.body,
	);

	const prBadge = branchStatus && branchStatus.prNumber !== null ? (
		<button
			onClick={(e) => {
				e.stopPropagation();
				if (branchStatus.prUrl) {
					window.open(branchStatus.prUrl, "_blank");
				}
			}}
			className="inline-flex items-center gap-1 text-[0.625rem] font-mono font-semibold text-green-400 bg-green-500/10 hover:bg-green-500/20 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
			title={t("infoPanel.openPRTooltip", { number: String(branchStatus.prNumber) })}
		>
			<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
			PR #{branchStatus.prNumber}
		</button>
	) : null;

	const branchStatusBadge = branchStatus && (branchStatus.ahead > 0 || branchStatus.behind > 0) ? (
		<span className="flex items-center gap-1.5 text-[0.6875rem] flex-shrink-0">
			{branchStatus.behind > 0 && branchStatus.ahead > 0 ? (
				<span className="font-medium">
					<span className="text-[#34d399]">{branchStatus.ahead} ahead</span>
					<span className="text-fg-muted"> · </span>
					<span className="text-[#fbbf24]">{branchStatus.behind} behind</span>
				</span>
			) : branchStatus.behind > 0 ? (
				<span className="text-[#fbbf24] font-medium">
					{t("infoPanel.commitsBehind", { count: String(branchStatus.behind) })}
				</span>
			) : (
				<span className="text-[#34d399] font-medium">
					{t("infoPanel.commitsAhead", { count: String(branchStatus.ahead) })}
				</span>
			)}
		</span>
	) : null;

	// -- Git action buttons: always visible when branchStatus is loaded --
	const rebaseDisabled = !branchStatus || branchStatus.behind === 0 || !branchStatus.canRebase || rebasing;
	const rebaseTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.behind === 0
			? t("infoPanel.rebaseDisabled")
			: !branchStatus.canRebase
				? t("infoPanel.rebaseConflicts")
				: t("infoPanel.rebase");

	const pushDisabled = !branchStatus || branchStatus.ahead === 0 || pushing;
	const pushTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t("infoPanel.pushDisabled")
			: t("infoPanel.push");

	const hasPR = branchStatus && branchStatus.prNumber !== null;
	const needsPushBeforePR = branchStatus && branchStatus.ahead > 0 && branchStatus.unpushed !== 0;
	const createPRDisabled = !branchStatus || branchStatus.ahead === 0 || creatingPR || pushing;

	function getPRButtonLabel(): string {
		if (creatingPR) return t("infoPanel.creatingPR");
		if (pushing && pushThenCreatePRRef.current) return t("infoPanel.pushingAndCreatingPR");
		if (needsPushBeforePR) return t("infoPanel.pushAndCreatePR");
		return t("infoPanel.createPR");
	}

	function getPRTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (branchStatus.ahead === 0) return t("infoPanel.createPRDisabledNoCommits");
		if (needsPushBeforePR) return t("infoPanel.pushAndCreatePR");
		return t("infoPanel.createPR");
	}

	const prButtonLabel = getPRButtonLabel();
	const createPRTooltip = getPRTooltip();

	const mergeDisabled = !branchStatus || branchStatus.ahead === 0 || branchStatus.behind > 0 || merging;
	const mergeTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t("infoPanel.mergeDisabledNoCommits")
			: branchStatus.behind > 0
				? t("infoPanel.mergeDisabledBehind")
				: t("infoPanel.merge");

	const showDiffDisabled = !branchStatus;
	const showDiffTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: t("infoPanel.showDiffTooltip", { branch: displayRef });

	const hasUncommitted = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0);
	const uncommittedDiffDisabled = !branchStatus || !hasUncommitted;
	const uncommittedDiffTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: !hasUncommitted
			? t("infoPanel.uncommittedDiffDisabled")
			: t("infoPanel.uncommittedDiffTooltip");

	const disabledBtnClass = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
	const enabledBtnClass = "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25";

	const gitActionButtons = isTaskActive && task.worktreePath ? (
		<span className="flex items-center gap-1 text-[0.6875rem] flex-shrink-0">
			<button
				onClick={handleShowDiff}
				disabled={showDiffDisabled}
				className={`px-2 py-0.5 rounded text-[0.625rem] font-semibold transition-colors ${
					showDiffDisabled
						? disabledBtnClass
						: "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/30"
				}`}
				title={showDiffTooltip}
			>
				{t("infoPanel.showDiff")}
			</button>
			<button
				onClick={handleShowUncommittedDiff}
				disabled={uncommittedDiffDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					uncommittedDiffDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={uncommittedDiffTooltip}
			>
				{t("infoPanel.uncommittedDiff")}
			</button>
			<button
				onClick={handleRebase}
				disabled={rebaseDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					rebaseDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={rebaseTooltip}
			>
				{rebasing ? t("infoPanel.rebasing") : t("infoPanel.rebase")}
			</button>
			<button
				onClick={handlePush}
				disabled={pushDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					pushDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={pushTooltip}
			>
				{pushing ? t("infoPanel.pushing") : t("infoPanel.push")}
			</button>
			{!hasPR && (
				<button
					onClick={() => {
						if (needsPushBeforePR) {
							pushThenCreatePRRef.current = true;
							handlePush();
						} else {
							handleCreatePR();
						}
					}}
					disabled={createPRDisabled}
					className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
						createPRDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					title={createPRTooltip}
				>
					{prButtonLabel}
				</button>
			)}
			<button
				onClick={handleMerge}
				disabled={mergeDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					mergeDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={mergeTooltip}
			>
				{merging ? t("infoPanel.merging") : t("infoPanel.merge")}
			</button>
			<button
				onClick={handleRefreshStatus}
				disabled={refreshingStatus}
				className="p-0.5 rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
				title={t("infoPanel.refreshStatus")}
			>
				<svg
					className={`w-3 h-3 ${refreshingStatus ? "animate-spin" : ""}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
						d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</button>
		</span>
	) : null;

	const devServerButton = (
		<>
			<button
				ref={devServerBtnRef}
				onClick={handleDevServer}
				disabled={devServerDisabled}
				className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
					devServerDisabled
						? "text-fg-muted/50 cursor-not-allowed"
						: "text-[#10b981] hover:text-[#34d399] hover:bg-[#10b981]/15 border border-[#10b981]/30"
				}`}
				title={devServerDisabled ? t("header.devServerDisabled") : t("header.devServer")}
			>
				<svg className="w-[1.125rem] h-[1.125rem]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
						d="M5 12h14M12 5l7 7-7 7" />
				</svg>
				<span className="text-[0.6875rem] font-semibold">{t("header.devServer")}</span>
			</button>
			{devServerMenuOpen && createPortal(
				<DevServerMenu
					position={devServerMenuPos}
					onRestart={handleDevServerRestart}
					onStop={handleDevServerStop}
					onClose={() => setDevServerMenuOpen(false)}
					t={t}
				/>,
				document.body,
			)}
		</>
	);

	// ---- "Open in..." button ----
	const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
	const [openInMenuPos, setOpenInMenuPos] = useState({ top: 0, left: 0 });
	const openInBtnRef = useRef<HTMLButtonElement>(null);

	function handleOpenInClick(e: React.MouseEvent) {
		e.stopPropagation();
		if (openInBtnRef.current) {
			const rect = openInBtnRef.current.getBoundingClientRect();
			setOpenInMenuPos({ top: rect.bottom + 4, left: rect.left });
		}
		setOpenInMenuOpen(true);
	}

	const spawnAgentButton = isTaskActive && task.worktreePath ? (
		<button
			onClick={() => setSpawnModalOpen(true)}
			className="flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-accent hover:text-accent-hover hover:bg-accent/15 border border-accent/30"
			title={t("tmux.spawnExtraAgentDesc")}
		>
			<span className="text-[1rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0219}"}</span>
			<span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("tmux.spawnExtraAgent")}</span>
		</button>
	) : null;

	const openInButton = isTaskActive && task.worktreePath ? (
		<div className="relative flex-shrink-0">
			<button
				ref={openInBtnRef}
				onClick={handleOpenInClick}
				className="flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-accent hover:text-accent-hover hover:bg-accent/15 border border-accent/30"
				title={t("openIn.menuTitle")}
			>
				<span className="text-[1rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
				<span className="text-[0.6875rem] font-semibold">{t("openIn.menuTitle")}</span>
			</button>
			{openInMenuOpen && task.worktreePath && (
				<OpenInMenu
					position={openInMenuPos}
					path={task.worktreePath}
					onClose={() => setOpenInMenuOpen(false)}
				/>
			)}
		</div>
	) : null;

	// ---- File browser (yazi) ----
	const [yaziInstallPopup, setYaziInstallPopup] = useState(false);
	const [yaziCopied, setYaziCopied] = useState(false);
	const [yaziInstallCmd, setYaziInstallCmd] = useState("");
	const [yaziLinuxHint, setYaziLinuxHint] = useState(false);

	async function handleFileBrowser() {
		if (!isTaskActive) return;
		try {
			const result = await api.request.openFileBrowser({ taskId: task.id, projectId: project.id });
			if (result && (result as any).notInstalled) {
				setYaziInstallCmd((result as any).installCommand);
				setYaziLinuxHint(!!(result as any).linuxHint);
				setYaziInstallPopup(true);
				return;
			}
		} catch (err) {
			alert(t("infoPanel.fileBrowserFailed", { error: String(err) }));
		}
	}

	const fileBrowserButton = (
		<div className="relative flex-shrink-0">
			<button
				onClick={handleFileBrowser}
				disabled={!isTaskActive}
				className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${
					!isTaskActive
						? "text-fg-muted/50 cursor-not-allowed"
						: "text-accent hover:text-accent-hover hover:bg-accent/15 border border-accent/30"
				}`}
				title={t("header.fileBrowser")}
			>
				<span className="text-[1.125rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0645}"}</span>
				<span className="text-[0.6875rem] font-semibold">{t("header.fileBrowser")}</span>
			</button>
			{yaziInstallPopup && createPortal(
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setYaziInstallPopup(false)}>
					<div className="bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-5 max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
						<div className="text-sm font-semibold text-fg mb-2">{t("fileBrowser.notInstalledTitle")}</div>
						<p className="text-fg-3 text-xs mb-3">{t("fileBrowser.notInstalledDesc")}</p>
						{yaziLinuxHint && <p className="text-fg-3 text-xs mb-2">{t("fileBrowser.linuxBrewHint")}</p>}
						<div className="flex items-center gap-2 mb-3">
							<code className="flex-1 text-yellow-400 bg-yellow-400/10 px-3 py-2 rounded text-xs font-mono break-all">
								{yaziInstallCmd}
							</code>
							<button
								onClick={() => {
									navigator.clipboard.writeText(yaziInstallCmd);
									setYaziCopied(true);
									setTimeout(() => setYaziCopied(false), 2000);
								}}
								className="p-2 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
								title="Copy"
							>
								{yaziCopied ? (
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<polyline points="20 6 9 17 4 12" />
									</svg>
								) : (
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
									</svg>
								)}
							</button>
						</div>
						{yaziCopied && <p className="text-green-400 text-xs mb-3">{t("requirements.copied")}</p>}
						<p className="text-fg-muted text-xs mb-3">{t("fileBrowser.clickAgainHint")}</p>
						<div className="flex justify-end">
							<button
								onClick={() => setYaziInstallPopup(false)}
								className="px-4 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
							>
								OK
							</button>
						</div>
					</div>
				</div>,
				document.body,
			)}
		</div>
	);

	const tmuxBtnClass = "px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25 flex items-center gap-1";

	const handleTmuxAction = (action: "splitH" | "splitV" | "zoom") => (e: React.MouseEvent) => {
		e.stopPropagation();
		api.request.tmuxAction({ taskId: task.id, action }).catch(() => {});
	};

	const tmuxHintsInline = (
		<div
			ref={hintsTriggerRef}
			className="flex items-center gap-1 flex-shrink-0"
			onMouseEnter={showHints}
			onMouseLeave={hideHints}
		>
			<button className={tmuxBtnClass} onClick={handleTmuxAction("splitH")} title={t("tmux.splitHDesc")}>
				<svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
					<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
					<line x1="1.5" y1="8" x2="14.5" y2="8" />
				</svg>
			</button>
			<button className={tmuxBtnClass} onClick={handleTmuxAction("splitV")} title={t("tmux.splitVDesc")}>
				<svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
					<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
					<line x1="8" y1="1.5" x2="8" y2="14.5" />
				</svg>
			</button>
			<button className={tmuxBtnClass} onClick={handleTmuxAction("zoom")} title={t("tmux.zoomDesc")}>
				<svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
					<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
					<polyline points="6,2.5 2.5,2.5 2.5,6" />
					<polyline points="10,13.5 13.5,13.5 13.5,10" />
				</svg>
			</button>
			<button
				className="w-5 h-5 rounded-full text-fg-muted hover:text-fg-2 hover:bg-elevated flex items-center justify-center transition-colors flex-shrink-0"
				onClick={(e) => { e.stopPropagation(); setHintsOpen((o) => !o); }}
				title={t("tmux.title")}
			>
				<svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
					<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zM7.25 5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5z" />
				</svg>
			</button>
		</div>
	);

	const popoverKbd = "font-mono text-xs text-fg-2 min-w-[3.5rem]";
	const popoverDesc = "text-xs text-fg-3";
	const popoverSection = "text-[0.625rem] text-fg-muted uppercase tracking-wider font-semibold mb-1.5";

	const tmuxHintsPopover = hintsOpen && createPortal(
		<div
			ref={hintsPopoverRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-4 min-w-[18.75rem]"
			style={{
				top: hintsPos.top,
				left: hintsPos.left,
				visibility: hintsVisible ? "visible" : "hidden",
			}}
			onMouseEnter={showHints}
			onMouseLeave={hideHints}
		>
			<div className="text-xs font-semibold text-fg mb-3">{t("tmux.title")}</div>

			{/* Panes */}
			<div className={popoverSection}>{t("tmux.panes")}</div>
			<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
				<kbd className={popoverKbd}>⌃B -</kbd><span className={popoverDesc}>{t("tmux.splitHDesc")}</span>
				<kbd className={popoverKbd}>⌃B |</kbd><span className={popoverDesc}>{t("tmux.splitVDesc")}</span>
				<kbd className={popoverKbd}>⌃B z</kbd><span className={popoverDesc}>{t("tmux.zoomDesc")}</span>
				<kbd className={popoverKbd}>⌃B x</kbd><span className={popoverDesc}>{t("tmux.closePaneDesc")}</span>
				<span className={popoverDesc + " col-span-2 mt-1.5 text-fg-muted"}>{t("tmux.selectPaneDesc")}</span>
				<span className={popoverDesc + " col-span-2 text-fg-muted"}>{t("tmux.resizePaneDesc")}</span>
			</div>
		</div>,
		document.body,
	);

	return (
		<div
			ref={panelRef}
			className="flex-shrink-0 border-b border-edge glass-header overflow-hidden transition-[height] duration-200 ease-out"
			style={{ height }}
		>
			{collapsed ? (
				/* ---- Collapsed: two rows ---- */
				<div className="flex flex-col h-full px-4">
					{/* Top row: status + labels + info hints */}
					<div className="flex items-center gap-1.5 min-w-0 pt-1">
						{statusDropdownButton}
						{statusDropdownPortal}
						{refDropdownPortal}
						{diffFilesPopover}
						{fileOpenInMenuPortal}
						{(task.labelIds ?? []).map((id) => {
							const label = (project.labels ?? []).find((l) => l.id === id);
							return label ? <LabelChip key={id} label={label} size="xs" /> : null;
						})}
						{diffStatsBadge}
						{prBadge}
						<div className="flex-1" />
						{spawnAgentButton}
						{openInButton}
						{fileBrowserButton}
						{tmuxHintsInline}
						{tmuxHintsPopover}
						{devServerButton}
						<button
							onClick={() => isFullPage
								? navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })
								: navigate({ screen: "task", projectId: project.id, taskId: task.id })
							}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={isFullPage ? t("infoPanel.exitFullScreen") : t("infoPanel.fullScreen")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								{isFullPage
									? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
									: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
								}
							</svg>
						</button>
						<button
							onClick={toggleCollapsed}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={t("infoPanel.expand")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
							</svg>
						</button>
					</div>
					{/* Bottom row: git (full width) */}
					<div className="flex items-center gap-1.5 min-w-0 pb-1">
						{task.branchName && (
							<span className="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[12.5rem]">
								{task.branchName}
							</span>
						)}
						{(branchStatusBadge || refDropdownButton || branchStatusLoading) && (
							<>
								{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
								{branchStatusBadge || branchStatusLoading}
								{refDropdownButton}
							</>
						)}
						{uncommittedBadge && (
							<>
								<span className="text-fg-muted text-xs flex-shrink-0">|</span>
								{uncommittedBadge}
							</>
						)}
						{gitActionButtons && (
							<>
								<span className="text-fg-muted text-xs flex-shrink-0">|</span>
								{gitActionButtons}
							</>
						)}
					</div>
				</div>
			) : (
				/* ---- Expanded ---- */
				<div className="flex flex-col h-full">
					{/* Header rows with controls */}
					<div className="flex flex-col px-4">
						{/* Top row: status + labels + info hints */}
						<div className="flex items-center gap-1.5 min-w-0 pt-1">
							{statusDropdownButton}
							{statusDropdownPortal}
						{refDropdownPortal}
						{diffFilesPopover}
						{fileOpenInMenuPortal}
							{(task.labelIds ?? []).map((id) => {
								const label = (project.labels ?? []).find((l) => l.id === id);
								return label ? <LabelChip key={id} label={label} size="xs" /> : null;
							})}
							{diffStatsBadge}
							{prBadge}
							<div className="flex-1" />
							{spawnAgentButton}
							{openInButton}
							{tmuxHintsInline}
							{tmuxHintsPopover}
							{devServerButton}
							<button
								onClick={() => isFullPage
									? navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })
									: navigate({ screen: "task", projectId: project.id, taskId: task.id })
								}
								className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								title={isFullPage ? t("infoPanel.exitFullScreen") : t("infoPanel.fullScreen")}
							>
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									{isFullPage
										? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
										: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
									}
								</svg>
							</button>
							<button
								onClick={toggleCollapsed}
								className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								title={t("infoPanel.collapse")}
							>
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
								</svg>
							</button>
						</div>
						{/* Bottom row: git (full width) */}
						<div className="flex items-center gap-1.5 min-w-0 pb-1">
							{task.branchName && (
								<span className="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[12.5rem]">
									{task.branchName}
								</span>
							)}
							{(branchStatusBadge || refDropdownButton) && (
								<>
									{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
									{branchStatusBadge}
									{refDropdownButton}
								</>
							)}
							{uncommittedBadge && (
								<>
									<span className="text-fg-muted text-xs flex-shrink-0">|</span>
									{uncommittedBadge}
								</>
							)}
							{gitActionButtons && (
								<>
									<span className="text-fg-muted text-xs flex-shrink-0">|</span>
									{gitActionButtons}
								</>
							)}
						</div>
					</div>

					{/* Metadata grid */}
					<div className="flex-1 overflow-auto px-4 pb-2">
						<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<span className="text-fg-3">{t("infoPanel.title")}</span>
							<InlineRename
								taskId={task.id}
								projectId={project.id}
								currentTitle={getTaskTitle(task)}
								hasCustomTitle={!!task.customTitle}
								dispatch={dispatch}
								className="text-fg-2 font-semibold truncate"
								inputClassName="w-full bg-base border border-edge-active rounded px-1.5 py-0.5 text-xs text-fg focus:outline-none focus:border-accent"
								showReset
							/>

							<span className="text-fg-3">{t("infoPanel.taskNumber")}</span>
							<span className="text-fg-2 font-mono font-semibold">#{task.seq}</span>

							{task.branchName && (
								<>
									<span className="text-fg-3">{t("infoPanel.branch")}</span>
									<span className="text-fg-2 font-mono">{task.branchName}</span>
								</>
							)}

							{branchStatus && branchStatus.prNumber !== null && (
								<>
									<span className="text-fg-3">{t("infoPanel.pullRequest")}</span>
									<button
										onClick={() => branchStatus.prUrl && window.open(branchStatus.prUrl, "_blank")}
										className="text-green-400 font-mono font-semibold hover:underline text-left"
									>
										PR #{branchStatus.prNumber}
									</button>
								</>
							)}

							{(() => {
								const projectLabels = project.labels ?? [];
								const assignedLabels = (task.labelIds ?? [])
									.map((id) => projectLabels.find((l) => l.id === id))
									.filter(Boolean) as typeof projectLabels;
								return assignedLabels.length > 0 ? (
									<>
										<span className="text-fg-3">{t("labels.taskLabels")}</span>
										<div className="flex items-center flex-wrap gap-1">
											{assignedLabels.map((label) => (
												<LabelChip key={label.id} label={label} size="xs" />
											))}
										</div>
									</>
								) : null;
							})()}

							{task.description && (
								<>
									<span className="text-fg-3">{t("infoPanel.description")}</span>
									<div>
										<span className="text-fg-2 whitespace-pre-wrap">{task.description}</span>
										<ImageAttachmentsStrip text={task.description} />
									</div>
								</>
							)}

							{task.worktreePath && (
								<>
									<span className="text-fg-3">{t("infoPanel.worktree")}</span>
									<span className="text-fg-3 font-mono truncate">{task.worktreePath}</span>
								</>
							)}

							<span className="text-fg-3">{t("infoPanel.created")}</span>
							<span className="text-fg-3">{formatDate(task.createdAt)}</span>

							<span className="text-fg-3">{t("infoPanel.updated")}</span>
							<span className="text-fg-3">{formatDate(task.updatedAt)}</span>
						</div>

						{/* Ports section */}
						{(() => {
							const ports = taskPorts?.get(task.id);
							if (!ports || ports.length === 0) return null;
							return (
								<div className="mt-3 border-t border-edge pt-3">
									<div className="flex items-center gap-2 mb-2">
										<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
										<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
											{t("ports.title")}
										</span>
										<span className="text-[0.625rem] text-fg-muted">
											{t.plural("ports.count", ports.length)}
										</span>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{ports.map((p) => (
											<button
												key={p.port}
												onClick={() => window.open(`http://localhost:${p.port}`, "_blank")}
												className="inline-flex items-center gap-1.5 text-xs font-mono text-accent bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded-md transition-colors"
												title={`${p.processName} (PID ${p.pid}) — ${t("ports.openInBrowser")}`}
											>
												<span className="font-bold">:{p.port}</span>
												<span className="text-fg-muted text-[0.625rem]">{p.processName}</span>
											</button>
										))}
									</div>
								</div>
							);
						})()}

						{/* Notes section */}
						<div className="mt-3 border-t border-edge pt-3">
							<div className="flex items-center justify-between mb-2">
								<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
									{t("notes.title")}
								</span>
								<button
									onClick={handleAddNote}
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
									onSave={(content) => handleUpdateNote(note.id, content)}
									onDelete={() => handleDeleteNote(note.id)}
									projectId={project.id}
								/>
							))}
						</div>
					</div>

					{/* Drag handle */}
					<div
						className="flex-shrink-0 flex items-center justify-center h-[6px] cursor-row-resize group"
						onMouseDown={onDragStart}
						onDoubleClick={onHandleDoubleClick}
					>
						<div className="w-8 h-[3px] rounded-full bg-fg-muted/40 group-hover:bg-fg-muted/70 transition-colors" />
					</div>
				</div>
			)}
		{spawnModalOpen && <SpawnAgentModal task={task} project={project} onClose={() => setSpawnModalOpen(false)} />}
		</div>
	);
}

export default TaskInfoPanel;
