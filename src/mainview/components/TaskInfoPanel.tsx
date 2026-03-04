import { useState, useRef, useCallback, useEffect, useLayoutEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Task, Project, TaskStatus, BranchStatus } from "../../shared/types";
import LabelChip from "./LabelChip";
import { NoteItem, formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, STATUS_COLORS, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { trackEvent } from "../analytics";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";

interface TaskInfoPanelProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

const COLLAPSED_HEIGHT = 62;
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


function TaskInfoPanel({ task, project, dispatch, navigate }: TaskInfoPanelProps) {
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
			dispatch({ type: "updateTask", task: { ...task, status: newStatus, worktreePath: null, branchName: null } });
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

	// ---- Dev server ----
	const hasDevScript = !!(project.devScript?.trim());
	const isTaskActive = ACTIVE_STATUSES.includes(task.status);
	const devServerDisabled = !hasDevScript || !isTaskActive;

	async function handleDevServer() {
		if (devServerDisabled) return;
		try {
			await api.request.runDevServer({ taskId: task.id, projectId: project.id });
		} catch (err) {
			alert(t("infoPanel.devServerFailed", { error: String(err) }));
		}
	}

	// ---- Branch status polling ----
	const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
	const [rebasing, setRebasing] = useState(false);
	const [merging, setMerging] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [refreshingStatus, setRefreshingStatus] = useState(false);
	const fetchStatusRef = useRef<(() => Promise<void>) | null>(null);

	useEffect(() => {
		if (!isTaskActive || !task.worktreePath) return;

		let cancelled = false;

		async function fetchStatus() {
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
				});
				if (!cancelled) setBranchStatus(status);
			} catch (err) {
				// Silently ignore — polling will retry
			}
		}

		fetchStatusRef.current = fetchStatus;
		fetchStatus();
		const interval = setInterval(fetchStatus, 15_000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [task.id, project.id, isTaskActive, task.worktreePath]);

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

	async function handleShowDiff() {
		try {
			await api.request.showDiff({
				taskId: task.id,
				projectId: project.id,
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
				});
				setBranchStatus(status);
			} catch { /* silently ignore */ }

			// Post-merge: show "complete task?" dialog
			if (detail.operation === "merge" && detail.ok) {
				const shouldComplete = await api.request.showConfirm({
					title: t("infoPanel.mergeComplete"),
					message: t("infoPanel.mergeCompleteMessage"),
				});
				if (shouldComplete) {
					const fromStatus = task.status;
					dispatch({ type: "updateTask", task: { ...task, status: "completed", worktreePath: null, branchName: null } });
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

	const statusColor = STATUS_COLORS[task.status];
	const height = collapsed ? COLLAPSED_HEIGHT : panelHeight;

	const statusDropdownButton = (
		<button
			ref={statusTriggerRef}
			onClick={toggleStatusMenu}
			disabled={movingStatus}
			className="flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-elevated transition-colors flex-shrink-0"
		>
			<div
				className="w-2 h-2 rounded-full flex-shrink-0"
				style={{ background: statusColor }}
			/>
			<span className="text-[11px] font-medium text-fg-2">
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
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[180px]"
			style={{
				top: statusMenuPos.top,
				left: statusMenuPos.left,
				visibility: statusMenuVisible ? "visible" : "hidden",
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("task.moveTo")}
			</div>
			{getAllowedTransitions(task.status).map((s) => (
				<button
					key={s}
					onClick={() => handleStatusMove(s)}
					className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
				>
					<div
						className="w-2.5 h-2.5 rounded-full flex-shrink-0"
						style={{ background: STATUS_COLORS[s] }}
					/>
					{t(statusKey(s))}
				</button>
			))}
		</div>,
		document.body,
	);

	const branchStatusLoading = isTaskActive && task.worktreePath && !branchStatus ? (
		<span className="flex items-center gap-1 text-[11px] text-fg-muted flex-shrink-0">
			<svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
				<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
			</svg>
		</span>
	) : null;

	const comparisonBranch = task.baseBranch || project.defaultBaseBranch || "main";

	const uncommittedBadge = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0) ? (
		<span className="flex items-center gap-1 text-[11px] font-medium text-danger flex-shrink-0">
			<span>+{branchStatus.insertions}</span>
			<span>/</span>
			<span>−{branchStatus.deletions}</span>
		</span>
	) : null;

	const branchStatusBadge = branchStatus && (branchStatus.ahead > 0 || branchStatus.behind > 0) ? (
		<span className="flex items-center gap-1.5 text-[11px] flex-shrink-0">
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
			<span className="text-fg-muted font-normal">vs {comparisonBranch}</span>
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
		: t("infoPanel.showDiffTooltip", { branch: comparisonBranch });

	const hasUncommitted = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0);
	const uncommittedDiffDisabled = !branchStatus || !hasUncommitted;
	const uncommittedDiffTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: !hasUncommitted
			? t("infoPanel.uncommittedDiffDisabled")
			: t("infoPanel.uncommittedDiffTooltip");

	const disabledBtnClass = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
	const enabledBtnClass = "text-accent hover:bg-accent/20 bg-accent/10";

	const gitActionButtons = isTaskActive && task.worktreePath ? (
		<span className="flex items-center gap-1 text-[11px] flex-shrink-0">
			<button
				onClick={handleShowDiff}
				disabled={showDiffDisabled}
				className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
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
				className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
					uncommittedDiffDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={uncommittedDiffTooltip}
			>
				{t("infoPanel.uncommittedDiff")}
			</button>
			<button
				onClick={handleRebase}
				disabled={rebaseDisabled}
				className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
					rebaseDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={rebaseTooltip}
			>
				{rebasing ? t("infoPanel.rebasing") : t("infoPanel.rebase")}
			</button>
			<button
				onClick={handlePush}
				disabled={pushDisabled}
				className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
					pushDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={pushTooltip}
			>
				{pushing ? t("infoPanel.pushing") : t("infoPanel.push")}
			</button>
			<button
				onClick={handleMerge}
				disabled={mergeDisabled}
				className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
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
		<button
			onClick={handleDevServer}
			disabled={devServerDisabled}
			className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
				devServerDisabled
					? "text-fg-muted/50 cursor-not-allowed"
					: "text-[#34d399] hover:text-[#6ee7b7] hover:bg-[#34d399]/10 border border-[#34d399]/30"
			}`}
			title={devServerDisabled ? t("header.devServerDisabled") : t("header.devServer")}
		>
			<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
					d="M5 12h14M12 5l7 7-7 7" />
			</svg>
			<span className="text-[11px] font-semibold">{t("header.devServer")}</span>
		</button>
	);

	const tmuxBtnClass = "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors text-accent hover:bg-accent/20 bg-accent/10 flex items-center gap-1";

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

	const popoverKbd = "font-mono text-xs text-fg-2 min-w-[56px]";
	const popoverDesc = "text-xs text-fg-3";
	const popoverSection = "text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-1.5";

	const tmuxHintsPopover = hintsOpen && createPortal(
		<div
			ref={hintsPopoverRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-4 min-w-[300px]"
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
						{(task.labelIds ?? []).map((id) => {
							const label = (project.labels ?? []).find((l) => l.id === id);
							return label ? <LabelChip key={id} label={label} size="xs" /> : null;
						})}
						<div className="flex-1" />
						{tmuxHintsInline}
						{tmuxHintsPopover}
						{devServerButton}
						<button
							onClick={() => navigate({ screen: "task", projectId: project.id, taskId: task.id })}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={t("infoPanel.fullScreen")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
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
							<span className="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[200px]">
								{task.branchName}
							</span>
						)}
						{(branchStatusBadge || branchStatusLoading) && (
							<>
								{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
								{branchStatusBadge || branchStatusLoading}
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
							{(task.labelIds ?? []).map((id) => {
								const label = (project.labels ?? []).find((l) => l.id === id);
								return label ? <LabelChip key={id} label={label} size="xs" /> : null;
							})}
							<div className="flex-1" />
							{tmuxHintsInline}
							{tmuxHintsPopover}
							{devServerButton}
							<button
								onClick={() => navigate({ screen: "task", projectId: project.id, taskId: task.id })}
								className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								title={t("infoPanel.fullScreen")}
							>
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
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
								<span className="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[200px]">
									{task.branchName}
								</span>
							)}
							{branchStatusBadge && (
								<>
									{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
									{branchStatusBadge}
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
							<span className="text-fg-3">{t("infoPanel.taskNumber")}</span>
							<span className="text-fg-2 font-mono font-semibold">#{task.seq}</span>

							{task.branchName && (
								<>
									<span className="text-fg-3">{t("infoPanel.branch")}</span>
									<span className="text-fg-2 font-mono">{task.branchName}</span>
								</>
							)}

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
		</div>
	);
}

export default TaskInfoPanel;
