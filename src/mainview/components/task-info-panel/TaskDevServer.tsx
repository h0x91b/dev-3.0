import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "../../toast";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useReducedMotion } from "../../utils/useReducedMotion";
import { useResolvedTaskProject } from "./useResolvedTaskProject";
import RemoteBetaWarning from "./RemoteBetaWarning";
import Tooltip from "../Tooltip";

interface TaskDevServerProps {
	task: Task;
	project: Project;
	isTaskActive: boolean;
	/** Icon-only rendering for a bar that is short on width. */
	compact?: boolean;
}

/**
 * Live status of the task's dev server, reflected directly on the button so the
 * user can tell at a glance whether it's up — `unknown` until the first poll
 * resolves, `starting` only during the transient start/restart phase.
 */
type DevServerState = "unknown" | "stopped" | "starting" | "running";

/** How often (ms) we re-check the dev-server tmux session while the panel is open. */
const DEV_SERVER_POLL_MS = 4500;

interface DevServerMenuProps {
	position: { top: number; left: number };
	onRestart: () => void;
	onStop: () => void;
	onClose: () => void;
}

function DevServerMenu({ position, onRestart, onStop, onClose }: DevServerMenuProps) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState(position);
	const [visible, setVisible] = useState(false);

	useEscapeKey(onClose);
	useEffect(() => {
		function handleClick(event: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [onClose]);

	useLayoutEffect(() => {
		if (!menuRef.current) {
			return;
		}

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
			onClick={(event) => event.stopPropagation()}
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

export default function TaskDevServer({ task, project, isTaskActive, compact = false }: TaskDevServerProps) {
	const t = useT();
	const reducedMotion = useReducedMotion();
	const resolvedProject = useResolvedTaskProject(task, project);
	const hasDevScript = !!resolvedProject.devScript?.trim();
	const devServerBtnRef = useRef<HTMLButtonElement>(null);
	const devServerHintRef = useRef<HTMLDivElement>(null);
	const [devServerMenuOpen, setDevServerMenuOpen] = useState(false);
	const [devServerMenuPos, setDevServerMenuPos] = useState({ top: 0, left: 0 });
	const [devServerHintOpen, setDevServerHintOpen] = useState(false);
	const [devServerHintCopied, setDevServerHintCopied] = useState(false);
	const [devServerHintPos, setDevServerHintPos] = useState({ top: 0, left: 0 });
	const [devState, setDevState] = useState<DevServerState>("unknown");

	// Track the live running state so the button can reflect it without a click.
	// There are no dev-server push messages, so we poll the (cheap) tmux
	// has-session check on mount + an interval, paused while the tab is hidden.
	// A `starting` transition set by a click handler is never clobbered by a poll.
	useEffect(() => {
		if (!hasDevScript || !isTaskActive) {
			setDevState("unknown");
			return;
		}
		let cancelled = false;
		async function poll() {
			try {
				const res = await api.request.checkDevServer({ taskId: task.id, projectId: project.id });
				if (cancelled) return;
				setDevState((prev) => (prev === "starting" ? prev : res?.running ? "running" : "stopped"));
			} catch {
				// Keep the last known state on a transient RPC error.
			}
		}
		poll();
		const id = setInterval(() => {
			if (typeof document !== "undefined" && document.hidden) return;
			poll();
		}, DEV_SERVER_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [task.id, project.id, hasDevScript, isTaskActive]);

	function openDevServerMenu() {
		if (devServerBtnRef.current) {
			const rect = devServerBtnRef.current.getBoundingClientRect();
			setDevServerMenuPos({ top: rect.bottom + 4, left: rect.left });
		}
		setDevServerMenuOpen(true);
	}

	async function startDevServerNow() {
		setDevState("starting");
		try {
			const status = await api.request.runDevServer({ taskId: task.id, projectId: project.id });
			setDevState(status?.running === false ? "stopped" : "running");
		} catch (err) {
			setDevState("stopped");
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	useEffect(() => {
		if (!devServerHintOpen) {
			return;
		}

		function onClickOutside(event: MouseEvent) {
			if (
				!devServerHintRef.current?.contains(event.target as Node) &&
				!devServerBtnRef.current?.contains(event.target as Node)
			) {
				setDevServerHintOpen(false);
				setDevServerHintCopied(false);
			}
		}

		document.addEventListener("mousedown", onClickOutside);
		return () => document.removeEventListener("mousedown", onClickOutside);
	}, [devServerHintOpen]);

	async function handleDevServer() {
		if (!hasDevScript) {
			if (!devServerHintOpen && devServerBtnRef.current) {
				const rect = devServerBtnRef.current.getBoundingClientRect();
				const popoverHeight = 100;
				const fitsBelow = rect.bottom + popoverHeight + 8 < window.innerHeight;
				setDevServerHintPos({
					top: fitsBelow ? rect.bottom + 4 : rect.top - popoverHeight - 4,
					left: Math.min(rect.left, window.innerWidth - 300),
				});
			}
			setDevServerHintOpen((open) => !open);
			setDevServerHintCopied(false);
			return;
		}

		if (!isTaskActive || devState === "starting") {
			return;
		}

		if (devState === "running") {
			openDevServerMenu();
			return;
		}

		if (devState === "stopped") {
			await startDevServerNow();
			return;
		}

		// State not yet resolved by a poll — check now, then act.
		try {
			const res = await api.request.checkDevServer({ taskId: task.id, projectId: project.id });
			if (res?.running) {
				setDevState("running");
				openDevServerMenu();
			} else {
				await startDevServerNow();
			}
		} catch (err) {
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleDevServerRestart() {
		setDevServerMenuOpen(false);
		setDevState("starting");
		try {
			const status = await api.request.restartDevServer({ taskId: task.id, projectId: project.id });
			setDevState(status?.running === false ? "stopped" : "running");
		} catch (err) {
			setDevState("stopped");
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleDevServerStop() {
		setDevServerMenuOpen(false);
		setDevState("stopped");
		try {
			await api.request.stopDevServer({ taskId: task.id, projectId: project.id });
		} catch (err) {
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	const devServerHintPrompt = t("header.devServerHintPrompt");

	// Active + has-script states drive the glanceable running indicator. Green
	// (success token) means running ONLY; stopped is neutral; the spinner is
	// reserved for the transient starting phase (never a steady "running" signal).
	const isRunning = hasDevScript && isTaskActive && devState === "running";
	const isStarting = hasDevScript && isTaskActive && devState === "starting";

	const stateClasses = !hasDevScript
		? "text-warning hover:text-warning hover:bg-warning/15 cursor-pointer border border-dashed border-warning/40"
		: !isTaskActive
			? "text-fg-muted/50 cursor-not-allowed border border-transparent"
			: isStarting
				? "text-fg-3 border border-edge cursor-progress"
				: isRunning
					? "text-success hover:text-success-hover hover:bg-success/15 border border-success/30"
					: "text-fg-2 hover:text-fg hover:bg-elevated-hover border border-edge";

	const devServerTitle = !hasDevScript
		? t("header.devServerDisabled")
		: !isTaskActive
			? t("header.devServer")
			: isStarting
				? t("header.devServerStartingTitle")
				: isRunning
					? t("header.devServerRunningTitle")
					: t("header.devServerStartTitle");

	const devServerLabel = !hasDevScript
		? t("header.setupDevServer")
		: isStarting
			? t("header.devServerStarting")
			: t("header.devServer");

	const devServerDetail = (
		<>
			{t("ttip.devServer")}
			<RemoteBetaWarning text={t("ttip.devServerRemoteWarning")} />
		</>
	);

	let devServerIcon: ReactNode;
	if (isRunning) {
		// Steady "alive" signal — a calm pulsing dot, not a spinner.
		devServerIcon = (
			<span className="w-[1.125rem] h-[1.125rem] flex items-center justify-center" aria-hidden>
				<span className={`w-2 h-2 rounded-full bg-success${reducedMotion ? "" : " animate-pulse"}`} />
			</span>
		);
	} else if (isStarting) {
		devServerIcon = (
			<span className="w-[1.125rem] h-[1.125rem] flex items-center justify-center" aria-hidden>
				<span
					className={`w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current${reducedMotion ? "" : " animate-spin"}`}
				/>
			</span>
		);
	} else if (hasDevScript && isTaskActive) {
		// Stopped (or not-yet-resolved): a "start" play affordance.
		devServerIcon = (
			<svg className="w-[1.125rem] h-[1.125rem]" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
				<path d="M8 5v14l11-7z" />
			</svg>
		);
	} else {
		// No-script / inactive: the original neutral arrow.
		devServerIcon = (
			<svg className="w-[1.125rem] h-[1.125rem]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M12 5l7 7-7 7" />
			</svg>
		);
	}

	return (
		<>
			<Tooltip content={devServerTitle} detail={devServerDetail}>
				<button
					ref={devServerBtnRef}
					onClick={handleDevServer}
					className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${stateClasses}`}
					aria-label={devServerTitle}
					aria-busy={isStarting}
				>
					{devServerIcon}
					{!compact && <span className="text-[0.6875rem] font-semibold">{devServerLabel}</span>}
				</button>
			</Tooltip>

			{devServerHintOpen && createPortal(
				<div
					ref={devServerHintRef}
					className="fixed z-[9999] bg-overlay border border-edge rounded-lg shadow-lg p-3 w-72"
					style={{ top: devServerHintPos.top, left: devServerHintPos.left }}
				>
					<div className="flex items-center justify-between mb-2">
						<p className="text-fg-2 text-xs">{t("header.devServerHint")}</p>
						<button
							onClick={() => {
								setDevServerHintOpen(false);
								setDevServerHintCopied(false);
							}}
							className="text-fg-muted hover:text-fg text-xs leading-none ml-2 -mr-1 -mt-1"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\uF00D"}
						</button>
					</div>
					<div className="flex items-center gap-1.5">
						<code className="flex-1 text-xs bg-base rounded px-2 py-1.5 text-fg font-mono select-all break-all">
							{devServerHintPrompt}
						</code>
						<button
							onClick={() => {
								navigator.clipboard.writeText(devServerHintPrompt);
								setDevServerHintCopied(true);
								setTimeout(() => setDevServerHintCopied(false), 2000);
							}}
							className="flex-shrink-0 px-2 py-1.5 rounded text-xs bg-accent hover:bg-accent-hover text-white transition-colors"
						>
							<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{devServerHintCopied ? "\uF00C" : "\uF0C5"}
							</span>
						</button>
					</div>
				</div>,
				document.body,
			)}

			{devServerMenuOpen && createPortal(
				<DevServerMenu
					position={devServerMenuPos}
					onRestart={handleDevServerRestart}
					onStop={handleDevServerStop}
					onClose={() => setDevServerMenuOpen(false)}
				/>,
				document.body,
			)}
		</>
	);
}
