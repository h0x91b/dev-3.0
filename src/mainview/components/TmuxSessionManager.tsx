import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { TmuxSessionInfo } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface TmuxSessionManagerProps {
	navigate: (route: Route) => void;
}

function TmuxSessionManager({ navigate }: TmuxSessionManagerProps) {
	const t = useT();

	const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
	const [popoverVisible, setPopoverVisible] = useState(false);
	const [copiedName, setCopiedName] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	const fetchSessions = useCallback(async () => {
		try {
			const result = await api.request.listTmuxSessions();
			setSessions(result);
		} catch {
			/* silently ignore */
		}
	}, []);

	// Poll every 30 seconds — use setTimeout chain (not setInterval) to
	// prevent stampede on app wake/reconnect.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		async function poll() {
			await fetchSessions();
			if (!cancelled) timer = setTimeout(poll, 30_000);
		}
		poll();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [fetchSessions]);

	// Refresh on popover open
	useEffect(() => {
		if (popoverOpen) fetchSessions();
	}, [popoverOpen, fetchSessions]);

	async function handleRefresh() {
		setRefreshing(true);
		await fetchSessions();
		setRefreshing(false);
	}

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
				setPopoverOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [popoverOpen]);

	// Escape to close
	useEffect(() => {
		if (!popoverOpen) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") setPopoverOpen(false);
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [popoverOpen]);

	// Viewport clamping
	useLayoutEffect(() => {
		if (!popoverOpen || !popoverRef.current || !buttonRef.current) return;
		const menu = popoverRef.current.getBoundingClientRect();
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
	}, [popoverOpen, sessions.length]);

	function togglePopover() {
		if (!popoverOpen && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPopoverPos({ top: rect.bottom + 6, left: rect.right });
			setPopoverVisible(false);
		}
		setPopoverOpen(!popoverOpen);
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
		const confirmed = await api.request.showConfirm({
			title: t("tmuxSessions.killAllConfirmTitle"),
			message: t("tmuxSessions.killAllConfirmMessage", {
				count: String(sessions.length),
			}),
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
		if (session.taskId && session.projectId) {
			navigate({ screen: "project", projectId: session.projectId, activeTaskId: session.taskId });
			setPopoverOpen(false);
		}
	}

	const count = sessions.length;

	return (
		<>
			<button
				ref={buttonRef}
				onClick={togglePopover}
				className={`flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated ${popoverOpen ? "bg-elevated text-fg" : ""}`}
				title={t("tmuxSessions.title")}
			>
				<svg
					className="w-[1.125rem] h-[1.125rem]"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<rect
						x="2"
						y="4"
						width="20"
						height="16"
						rx="2"
						strokeWidth={1.5}
					/>
					<path
						d="M6 9l4 3-4 3"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
					/>
					<path
						d="M12 15h6"
						strokeLinecap="round"
						strokeWidth={1.5}
					/>
				</svg>
				{count > 0 && (
					<span className="min-w-[1.125rem] h-[1.125rem] flex items-center justify-center text-[0.625rem] font-bold bg-accent/20 text-accent rounded-full px-1">
						{count}
					</span>
				)}
			</button>

			{popoverOpen &&
				createPortal(
					<div
						ref={popoverRef}
						className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-2 min-w-[22.5rem] max-w-[30rem] max-h-[25rem] flex flex-col"
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
								<button
									onClick={handleRefresh}
									disabled={refreshing}
									className="text-fg-3 hover:text-fg hover:bg-elevated p-1 rounded transition-colors disabled:opacity-40"
									title={t("tmuxSessions.refresh")}
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
								{count > 0 && (
									<button
										onClick={handleKillAll}
										className="text-[0.625rem] text-danger hover:bg-danger/10 px-2 py-0.5 rounded transition-colors font-medium"
									>
										{t("tmuxSessions.killAll")}
									</button>
								)}
							</div>
						</div>

						{/* Session list */}
						<div className="flex-1 overflow-auto">
							{sessions.length === 0 ? (
								<div className="px-4 py-6 text-center text-sm text-fg-muted">
									{t("tmuxSessions.empty")}
								</div>
							) : (
								sessions.map((session) => {
									const canNavigate = !!(session.taskId && session.projectId);
									return (
										<div
											key={session.name}
											className={`px-4 py-2.5 hover:bg-elevated-hover transition-colors border-b border-edge/50 last:border-0${canNavigate ? " cursor-pointer" : ""}`}
											onClick={() => handleSessionClick(session)}
										>
											{/* Session name + badges + kill */}
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2 min-w-0">
													<span className={`text-sm font-semibold truncate${canNavigate ? " text-accent" : " text-fg"}`} title={session.name}>
														{session.taskTitle || session.name}
													</span>
													{session.isCleanup && (
														<span className="text-[0.5625rem] bg-danger/15 text-danger px-1.5 py-0.5 rounded font-medium flex-shrink-0">
															{t("tmuxSessions.cleanup")}
														</span>
													)}
												</div>
												<button
													onClick={(e) => {
														e.stopPropagation();
														handleKill(session.name);
													}}
													className="flex-shrink-0 text-[0.625rem] text-danger hover:bg-danger/10 px-2 py-0.5 rounded transition-colors font-medium"
												>
													{t("tmuxSessions.kill")}
												</button>
											</div>

											{/* Working directory */}
											{session.cwd && (
												<div
													className="text-[0.6875rem] text-fg-3 font-mono truncate mt-1"
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
															className="inline-flex items-center gap-1 text-[0.625rem] font-mono text-accent bg-accent/10 hover:bg-accent/20 px-1.5 py-0.5 rounded transition-colors"
															title={`${p.processName} (PID ${p.pid})`}
														>
															<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
															:{p.port}
														</button>
													))}
												</div>
											)}

											{/* Copy attach command */}
											<button
												onClick={(e) => {
													e.stopPropagation();
													handleCopy(session.name);
												}}
												className="mt-1.5 flex items-center gap-1.5 text-[0.625rem] text-accent hover:text-accent-hover transition-colors"
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
