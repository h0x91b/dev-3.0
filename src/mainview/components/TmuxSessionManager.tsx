import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { TmuxSessionInfo } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import HelpSpot from "./HelpSpot";
import { formatBytes } from "../utils/formatBytes";
import { startVisibilityAwarePoll } from "../utils/poll";
import { computeMenuFlyoutPosition, MENU_FLYOUT_CLOSE_MS, MENU_FLYOUT_HOVER_MS } from "../utils/menuFlyout";
import Tooltip from "./Tooltip";

interface TmuxSessionManagerProps {
	navigate: (route: Route) => void;
	/** `bar` is the icon-only header chip; `menu` is the labelled row in the header's overflow menu. */
	variant?: "bar" | "menu";
}

const SESSION_REFRESH_FRESH_MS = 5000;
/** Renewal cadence for the backend's fast resource tick — well inside its TTL. */
const BOOST_HEARTBEAT_MS = 5000;
/** Session list (not the numbers — those arrive as pushes) while the popover is open. */
const OPEN_LIST_REFRESH_MS = 5000;

type SortKey = "memory" | "cpu";

const SORT_STORAGE_KEY = "dev3-tmux-session-sort";

function readStoredSort(): SortKey {
	try {
		return localStorage.getItem(SORT_STORAGE_KEY) === "cpu" ? "cpu" : "memory";
	} catch {
		return "memory";
	}
}

/**
 * Heaviest first on the chosen metric. Sessions with no reading at all — project
 * terminals, a task whose first resource tick has not landed — keep their
 * newest-first order below the measured ones rather than claiming a zero.
 */
function sortSessions(sessions: TmuxSessionInfo[], key: SortKey): TmuxSessionInfo[] {
	const metric = (s: TmuxSessionInfo) =>
		key === "cpu" ? s.resourceUsage?.cpu : s.resourceUsage?.rss;
	return [...sessions].sort((a, b) => {
		const av = metric(a);
		const bv = metric(b);
		if (av === undefined && bv === undefined) return b.createdAt - a.createdAt;
		if (av === undefined) return 1;
		if (bv === undefined) return -1;
		if (bv !== av) return bv - av;
		return b.createdAt - a.createdAt;
	});
}

function TmuxSessionManager({ navigate, variant = "bar" }: TmuxSessionManagerProps) {
	const t = useT();
	const privacy = useProjectPrivacy();

	const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
	const [popoverVisible, setPopoverVisible] = useState(false);
	const [copiedName, setCopiedName] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
	/**
	 * Hover opens the menu flyout, a click PINS it: without the distinction the
	 * click that follows a hover-open would immediately close the panel again.
	 */
	const [pinned, setPinned] = useState(false);

	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastLoadedAtRef = useRef(0);
	const inFlightFetchRef = useRef<Promise<TmuxSessionInfo[]> | null>(null);
	const sessionsRef = useRef<TmuxSessionInfo[]>([]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	const fetchSessions = useCallback(async (options?: { force?: boolean }) => {
		const force = options?.force ?? false;
		const listTmuxSessions = api.request.listTmuxSessions;
		if (typeof listTmuxSessions !== "function") {
			return sessionsRef.current;
		}

		if (!force && Date.now() - lastLoadedAtRef.current < SESSION_REFRESH_FRESH_MS) {
			return inFlightFetchRef.current ?? sessionsRef.current;
		}

		if (inFlightFetchRef.current) {
			return inFlightFetchRef.current;
		}

		const request = listTmuxSessions()
			.then((result) => {
				setSessions(result);
				lastLoadedAtRef.current = Date.now();
				return result;
			})
			.catch(() => sessionsRef.current)
			.finally(() => {
				inFlightFetchRef.current = null;
			});

		inFlightFetchRef.current = request;
		return request;
	}, []);

	// Poll every 30 seconds. Visibility-aware so it pauses while the app is
	// hidden and runs a single refresh on wake — no stampede on resume.
	useEffect(() => {
		return startVisibilityAwarePoll({ fn: async () => { await fetchSessions(); }, intervalMs: 30_000 });
	}, [fetchSessions]);

	// Refresh on popover open
	useEffect(() => {
		if (popoverOpen) void fetchSessions();
	}, [popoverOpen, fetchSessions]);

	/**
	 * While the list is on screen the readout goes live: the backend's resource
	 * monitor drops from a 10 s to a 2 s tick and pushes each task's numbers as
	 * they move. The boost is renewed on a heartbeat and lapses by itself, so a
	 * browser tab closed in remote mode cannot leave the fast tick running.
	 */
	useEffect(() => {
		const setBoost = api.request.setResourceMonitorBoost;
		if (!popoverOpen || typeof setBoost !== "function") return;
		let stopped = false;
		const renew = () => {
			if (!stopped) void setBoost({ active: true }).catch(() => {});
		};
		renew();
		const heartbeat = setInterval(renew, BOOST_HEARTBEAT_MS);
		// The pushes carry the numbers; this only catches sessions appearing or dying.
		const listTimer = setInterval(() => { void fetchSessions({ force: true }); }, OPEN_LIST_REFRESH_MS);
		return () => {
			stopped = true;
			clearInterval(heartbeat);
			clearInterval(listTimer);
			void setBoost({ active: false }).catch(() => {});
		};
	}, [popoverOpen, fetchSessions]);

	// Live numbers, patched in place: re-sorting on every tick is deliberate —
	// the list is a "what is eating the machine" view, so the heaviest stays on top.
	useEffect(() => {
		if (!popoverOpen) return;
		function onUsage(e: Event) {
			const detail = (e as CustomEvent<{ taskId: string; usage: { cpu: number; rss: number } }>).detail;
			if (!detail?.taskId) return;
			setSessions((prev) => {
				let changed = false;
				const next = prev.map((session) => {
					if (session.taskId?.slice(0, 8) !== detail.taskId) return session;
					changed = true;
					return { ...session, resourceUsage: detail.usage };
				});
				return changed ? next : prev;
			});
		}
		window.addEventListener("rpc:resourceUsageUpdated", onUsage);
		return () => window.removeEventListener("rpc:resourceUsageUpdated", onUsage);
	}, [popoverOpen]);

	function handleSortChange(key: SortKey) {
		setSortKey(key);
		try {
			localStorage.setItem(SORT_STORAGE_KEY, key);
		} catch {
			/* a private window may refuse storage; the choice still applies this session */
		}
	}

	// Refresh when any task is updated (e.g. title renamed)
	useEffect(() => {
		function onTaskUpdated() {
			void fetchSessions({ force: true });
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [fetchSessions]);

	async function handleRefresh() {
		setRefreshing(true);
		await fetchSessions({ force: true });
		setRefreshing(false);
	}

	const cancelTimers = useCallback(() => {
		if (openTimer.current !== null) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	useEffect(() => cancelTimers, [cancelTimers]);

	const closePopover = useCallback(() => {
		cancelTimers();
		setPopoverOpen(false);
		setPinned(false);
	}, [cancelTimers]);

	/** Hover intent, menu row only: a pointer travelling past must not open it. */
	const scheduleOpen = useCallback(() => {
		cancelTimers();
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setPopoverVisible(false);
			setPopoverOpen(true);
		}, MENU_FLYOUT_HOVER_MS);
	}, [cancelTimers]);

	const scheduleClose = useCallback(() => {
		cancelTimers();
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setPopoverOpen((wasOpen) => (pinned ? wasOpen : false));
		}, MENU_FLYOUT_CLOSE_MS);
	}, [cancelTimers, pinned]);

	// Click outside to close
	useEffect(() => {
		if (!popoverOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node) &&
				buttonRef.current &&
				!buttonRef.current.contains(e.target as Node)
			) {
				closePopover();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [popoverOpen, closePopover]);

	// Escape to close
	useEscapeKey(closePopover, { enabled: popoverOpen });

	// Placement: the menu row hangs its flyout off the menu's outboard edge so the
	// list stays clickable underneath; the header chip drops it below itself.
	useLayoutEffect(() => {
		if (!popoverOpen || !popoverRef.current || !buttonRef.current) return;
		const menu = popoverRef.current.getBoundingClientRect();
		if (variant === "menu") {
			setPopoverPos(computeMenuFlyoutPosition(buttonRef.current, { width: menu.width, height: menu.height }));
			setPopoverVisible(true);
			return;
		}
		const trigger = buttonRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.right - menu.width;

		if (top + menu.height > vh - pad) top = trigger.top - menu.height - 6;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPopoverPos({ top, left });
		setPopoverVisible(true);
	}, [popoverOpen, sessions.length, variant]);

	function togglePopover() {
		if (popoverOpen && (pinned || variant !== "menu")) {
			closePopover();
			return;
		}
		if (!popoverOpen && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPopoverPos({ top: rect.bottom + 6, left: rect.right });
			setPopoverVisible(false);
		}
		cancelTimers();
		setPopoverOpen(true);
		setPinned(true);
	}

	async function handleKill(sessionName: string) {
		try {
			await api.request.killTmuxSession({ sessionName });
		} catch {
			/* best effort */
		}
		// Always remove from UI — if the kill failed, the session will
		// reappear on the next refresh/poll anyway.
		setSessions((prev) => prev.filter((s) => s.name !== sessionName));
	}

	async function handleKillAll() {
		if (sessions.length === 0) return;
		const confirmed = await confirm({
			title: t("tmuxSessions.killAllConfirmTitle"),
			message: t.plural("tmuxSessions.killAllConfirmMessage", sessions.length),
			confirmLabel: t("tmuxSessions.killAllConfirmLabel"),
			danger: true,
		});
		if (!confirmed) return;
		for (const session of sessions) {
			try {
				await api.request.killTmuxSession({
					sessionName: session.name,
				});
			} catch {
				/* best effort */
			}
		}
		setSessions([]);
	}

	function handleCopy(sessionName: string) {
		navigator.clipboard.writeText(`tmux -L dev3 attach -t ${sessionName}`);
		setCopiedName(sessionName);
		setTimeout(() => setCopiedName(null), 1500);
	}

	function handleSessionClick(session: TmuxSessionInfo) {
		if (session.isProjectTerminal && session.projectId) {
			navigate({ screen: "project-terminal", projectId: session.projectId });
			closePopover();
		} else if (session.taskId && session.projectId) {
			navigate({ screen: "project", projectId: session.projectId, activeTaskId: session.taskId });
			closePopover();
		}
	}

	const count = sessions.length;
	const sortedSessions = sortSessions(sessions, sortKey);

	const glyph = (
		<span
			className="text-lg leading-none"
			style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
		>
			{"\u{EBC8}"}
		</span>
	);

	const countBadge = count > 0 ? (
		<span className="min-w-[1.125rem] h-[1.125rem] flex items-center justify-center text-dense font-bold bg-accent/20 text-accent rounded-full px-1">
			{count}
		</span>
	) : null;

	const trigger = variant === "menu" ? (
		<button
			ref={buttonRef}
			role="menuitem"
			onClick={togglePopover}
			onMouseEnter={scheduleOpen}
			onMouseLeave={scheduleClose}
			aria-haspopup="dialog"
			aria-expanded={popoverOpen}
			className="header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
			aria-label={t("tmuxSessions.title")}
		>
			<span className="flex w-[1.125rem] justify-center flex-shrink-0">{glyph}</span>
			<span className="text-sm flex-1 text-left">{t("tmuxSessions.title")}</span>
			{countBadge}
		</button>
	) : (
		<Tooltip content={t("tmuxSessions.title")} detail={t("ttip.header.tmuxSessions")}>
		<button
			ref={buttonRef}
			onClick={togglePopover}
			className={`flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-1.5 py-1 rounded-lg hover:bg-elevated ${popoverOpen ? "bg-elevated text-fg" : ""}`}
			aria-label={t("tmuxSessions.title")}
		>
			{glyph}
			{countBadge}
		</button>
		</Tooltip>
	);

	return (
		<>
			{trigger}

			{popoverOpen &&
				createPortal(
					<div
						ref={popoverRef}
						onMouseEnter={variant === "menu" ? cancelTimers : undefined}
						onMouseLeave={variant === "menu" ? scheduleClose : undefined}
						// Portaled outside the kebab, so the menu's outside-click handler
						// needs this marker to keep itself open while the flyout is used.
						data-header-flyout={variant === "menu" ? "true" : undefined}
						// z-[80] so the popover layers above the narrow header bottom sheet
						// (z-[70]) when the tmux manager is folded into it on mobile.
						className="fixed z-[80] bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-2 min-w-[22.5rem] max-w-[30rem] max-h-[25rem] flex flex-col"
						style={{
							top: popoverPos.top,
							left: popoverPos.left,
							visibility: popoverVisible ? "visible" : "hidden",
						}}
					>
						{/* Header */}
						<div className="flex items-center justify-between px-4 pb-2 border-b border-edge">
							<span className="text-xs font-semibold text-fg">
								{t("tmuxSessions.title")}
								<span className="ml-2 text-fg-3 font-normal">
									{t.plural(
										"tmuxSessions.sessionCount",
										count,
									)}
								</span>
							</span>
							<div className="flex items-center gap-1">
								<HelpSpot topicId="header.tmux-sessions" />
								<Tooltip content={t("tmuxSessions.refresh")}>
								<button
									onClick={handleRefresh}
									disabled={refreshing}
									className="text-fg-3 hover:text-fg hover:bg-elevated p-1 rounded transition-colors disabled:opacity-40"
									aria-label={t("tmuxSessions.refresh")}
								>
									<svg
										className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											d="M4 4v5h5M20 20v-5h-5M4 9a9 9 0 0114.13-3.36M20 15a9 9 0 01-14.13 3.36"
											strokeWidth={2}
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
								</button>
								</Tooltip>
								{count > 0 && (
									<button
										onClick={handleKillAll}
										className="text-dense text-danger hover:bg-danger/10 px-2 py-0.5 rounded transition-colors font-medium"
									>
										{t("tmuxSessions.killAll")}
									</button>
								)}
							</div>
						</div>

						{/* Sort control + live indicator */}
						{count > 0 && (
							<div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-edge/50">
								<div className="flex items-center gap-1.5">
									<span className="text-nano uppercase tracking-wide text-fg-muted">
										{t("tmuxSessions.sortLabel")}
									</span>
									<div role="group" aria-label={t("tmuxSessions.sortLabel")} className="flex items-center gap-0.5 bg-raised rounded-md p-0.5">
										{([
											["memory", "tmuxSessions.sortByMemory"],
											["cpu", "tmuxSessions.sortByCpu"],
										] as const).map(([key, labelKey]) => (
											<button
												key={key}
												onClick={() => handleSortChange(key)}
												aria-pressed={sortKey === key}
												className={`text-dense px-2 py-0.5 rounded transition-colors ${
													sortKey === key
														? "bg-accent/20 text-accent font-medium"
														: "text-fg-3 hover:text-fg hover:bg-elevated"
												}`}
											>
												{t(labelKey)}
											</button>
										))}
									</div>
								</div>
								<Tooltip content={t("tmuxSessions.liveHint")}>
									<span className="flex items-center gap-1 text-nano text-fg-muted">
										<span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
										{t("tmuxSessions.live")}
									</span>
								</Tooltip>
							</div>
						)}

						{/* Session list */}
						<div className="flex-1 overflow-auto">
							{sessions.length === 0 ? (
								<div className="px-4 py-6 text-center text-sm text-fg-muted">
									<p>{t("tmuxSessions.empty")}</p>
									<p className="text-xs mt-1">{t("tmuxSessions.emptyHint")}</p>
								</div>
							) : (
								sortedSessions.map((session) => {
									const isOrphaned = !session.isProjectTerminal && !session.isCleanup && !session.taskId;
									const canNavigate = !!(session.isProjectTerminal ? session.projectId : (session.taskId && session.projectId));
									return (
										<div
											key={session.name}
											data-session-name={session.name}
											role={canNavigate ? "button" : undefined}
											tabIndex={canNavigate ? 0 : undefined}
											className={`px-4 py-2.5 hover:bg-elevated-hover transition-colors border-b border-edge/50 last:border-0${canNavigate ? " cursor-pointer" : ""}`}
											onClick={canNavigate ? () => handleSessionClick(session) : undefined}
											onKeyDown={canNavigate ? (e: React.KeyboardEvent) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													handleSessionClick(session);
												}
											} : undefined}
										>
											{/* Session name + badges + kill */}
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2 min-w-0">
													<span className={`text-sm font-semibold truncate${canNavigate ? " text-accent" : " text-fg"} ${privacy.maskClass(session.projectId)}`} title={privacy.isLocked(session.projectId) ? undefined : session.name}>
														{session.isProjectTerminal
															? (session.projectName || session.name)
															: (session.taskTitle || session.name.replace(/^dev3-/, ""))}
													</span>
													{session.isProjectTerminal && (
														<span className="text-nano bg-accent/15 text-accent px-1.5 py-0.5 rounded font-medium flex-shrink-0">
															{t("projectTerminal.label")}
														</span>
													)}
													{session.isCleanup && (
														<span className="text-nano bg-danger/15 text-danger px-1.5 py-0.5 rounded font-medium flex-shrink-0">
															{t("tmuxSessions.cleanup")}
														</span>
													)}
													{isOrphaned && (
														<span className="text-nano bg-fg-muted/15 text-fg-muted px-1.5 py-0.5 rounded font-medium flex-shrink-0">
															{t("tmuxSessions.orphaned")}
														</span>
													)}
												</div>
												<button
													onClick={(e) => {
														e.stopPropagation();
														handleKill(session.name);
													}}
													className="flex-shrink-0 text-dense text-danger hover:bg-danger/10 px-2 py-0.5 rounded transition-colors font-medium"
												>
													{t("tmuxSessions.kill")}
												</button>
											</div>

											{/* Working directory */}
											{session.cwd && (
												<div
													className="text-micro text-fg-3 font-mono truncate mt-1"
													title={session.cwd}
												>
													{session.cwd}
												</div>
											)}

											{/* Port badges */}
											{session.ports && session.ports.length > 0 && (
												<div className="flex flex-wrap gap-1 mt-1.5">
													{session.ports.map((p) => (
														<button
															key={p.port}
															onClick={(e) => {
																e.stopPropagation();
																window.open(`http://localhost:${p.port}`, "_blank");
															}}
															className="inline-flex items-center gap-1 text-dense font-mono text-accent bg-accent/10 hover:bg-accent/20 px-1.5 py-0.5 rounded transition-colors"
															title={`${p.processName} (PID ${p.pid})`}
														>
															<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
															:{p.port}
														</button>
													))}
												</div>
											)}

											{/* Resource usage */}
											{session.resourceUsage && (
												<div className="flex items-center gap-1.5 mt-1.5 text-dense font-mono text-fg-3">
													<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F035B}"}</span>
													<span>{formatBytes(session.resourceUsage.rss)}</span>
													<span className="text-fg-muted">·</span>
													<span>{session.resourceUsage.cpu.toFixed(1)}% CPU</span>
												</div>
											)}

											{/* Copy attach command */}
											<button
												onClick={(e) => {
													e.stopPropagation();
													handleCopy(session.name);
												}}
												className="mt-1.5 inline-flex items-center gap-1.5 text-dense text-accent hover:text-accent-emphasis transition-colors"
											>
												<svg
													className="w-3 h-3 flex-shrink-0"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<rect
														x="9"
														y="9"
														width="13"
														height="13"
														rx="2"
														strokeWidth={2}
													/>
													<path
														d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
														strokeWidth={2}
													/>
												</svg>
												{copiedName === session.name
													? t("tmuxSessions.copied")
													: `tmux -L dev3 attach -t ${session.name}`}
											</button>
										</div>
									);
								})
							)}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

export default TmuxSessionManager;
