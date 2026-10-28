import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { toast } from "../../toast";
import { createPortal } from "react-dom";
import type { DevServerStatus, Project, Task } from "../../../shared/types";
import { formatDevServerArgs, resolveDevServers } from "../../../shared/dev-servers";
import { api } from "../../rpc";
import { traceDevServerOp, type DevServerTrace } from "../../dev-server-trace";

/** Whether a paint happened before the request settled, or after it. */
type RenderBoundary = "optimistic" | "settled";

/**
 * One dev-server state poll per TASK, not per mounted effect. StrictMode double-mounts
 * and a task switch both re-run the effect, and a single RPC can hang for two minutes,
 * so an effect-scoped guard still lets a remount stack a second hung request. Joining
 * the in-flight promise keeps it to one (seq 1407).
 */
const devServerPollsInFlight = new Map<string, Promise<unknown>>();

/** Test-only: drop the registry between cases. */
export function _resetDevServerPollRegistry(): void {
	devServerPollsInFlight.clear();
}
import { useT } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useViewportClamp } from "../../hooks/useViewportClamp";
import { RescanIcon } from "../HeaderIcons";
import { PlayIcon, SetupArrowIcon } from "../TaskIcons";
import { useReducedMotion } from "../../utils/useReducedMotion";
import { useResolvedTaskProject } from "./useResolvedTaskProject";
import RemoteBetaWarning from "./RemoteBetaWarning";
import Tooltip from "../Tooltip";
import { useIsControlHidden } from "../../hooks/useIsControlHidden";
import HideableControl from "../HideableControl";

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
	scriptArgs: string[];
	onRestart: () => void;
	onStop: () => void;
	onClose: () => void;
}

function DevServerMenu({ position, scriptArgs, onRestart, onStop, onClose }: DevServerMenuProps) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const argsText = formatDevServerArgs(scriptArgs);
	const { position: menuPos, visible } = useViewportClamp(menuRef, position, argsText);

	useEscapeKey(onClose);
	useArrowKeyFocus(menuRef, visible);

	return (
		<>
		<DismissBackdrop onClose={onClose} />
		<div
			ref={menuRef}
			onKeyDown={(event) => moveFocusWithArrows(event, menuRef.current)}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem] w-max select-none"
			style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("header.devServerRunning")}
			</div>
			{scriptArgs.length > 0 && (
				<div
					className="px-3 -mt-1 pb-2 font-mono text-xs text-fg-3 truncate max-w-[16rem]"
					title={t("header.devServerArgsTitle", { args: argsText })}
					data-testid="dev-server-args"
				>
					{argsText}
				</div>
			)}
			<button
				type="button"
				onClick={onRestart}
				className={`header-anim w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-fg/10 hover:text-fg flex items-center gap-2.5 transition-colors ${FOCUS_ROW}`}
			>
				<RescanIcon className="w-4 h-4 flex-shrink-0" />
				{t("header.devServerRestart")}
			</button>
			<button
				type="button"
				onClick={onStop}
				className={`w-full text-left px-3 py-2 text-sm text-danger hover:bg-fg/10 flex items-center gap-2.5 transition-colors ${FOCUS_ROW}`}
			>
				<svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
					<rect x="5" y="5" width="14" height="14" rx="2" />
				</svg>
				{t("header.devServerStop")}
			</button>
		</div>
		</>
	);
}


interface DevServerListProps {
	position: { top: number; left: number };
	servers: Array<{ name: string; title: string; isDefault: boolean }>;
	status: DevServerStatus | null;
	busy: string | null;
	onStart: (name: string) => void;
	onStop: (name: string) => void;
	onRestart: (name: string) => void;
	onStartAll: () => void;
	onStopAll: () => void;
	onClose: () => void;
}

/**
 * Keyboard focus ring shared by every actionable row in the dev-server panels.
 * Hover/focus fills use `fg/10`: `elevated-hover` is within a few RGB steps of `overlay` and vanished.
 */
const FOCUS_ROW = "outline-none focus-visible:bg-fg/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";
const FOCUS_CHIP = "outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/**
 * Transparent click-catcher under a portalled panel, the same one the toolbar's
 * Ports and Scripts menus use. A document `mousedown` listener cannot do this job:
 * the terminal captures its own mousedown, so a click on it never reached one, and
 * the toolbar button's click re-opened the panel that its mousedown had just closed.
 */
function DismissBackdrop({ onClose }: { onClose: () => void }) {
	return <div className="fixed inset-0 z-40" data-testid="dev-server-backdrop" aria-hidden onClick={onClose} />;
}

function panelButtons(panel: HTMLElement | null): HTMLButtonElement[] {
	return panel ? [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")] : [];
}

/** ArrowUp/ArrowDown/Home/End walk the panel's buttons; Tab keeps its natural order. */
function moveFocusWithArrows(event: KeyboardEvent<HTMLElement>, panel: HTMLElement | null) {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const buttons = panelButtons(panel);
	if (buttons.length === 0) return;
	event.preventDefault();
	const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
	const last = buttons.length - 1;
	const next = event.key === "Home" ? 0
		: event.key === "End" ? last
			: event.key === "ArrowDown" ? (current + 1) % buttons.length
				: (current <= 0 ? last : current - 1);
	buttons[next]?.focus();
}

/**
 * Focus the panel's first button on open, and again whenever a re-render drops
 * focus to `<body>` — a row that starts its server is replaced by Restart/Stop,
 * and the keyboard user must not be left outside the panel.
 */
function useArrowKeyFocus(panelRef: RefObject<HTMLElement | null>, visible: boolean, renderKey?: unknown) {
	const mountedRef = useRef(false);
	useEffect(() => {
		// A `visibility: hidden` panel (before its viewport clamp) cannot take focus.
		if (!visible) return;
		const active = document.activeElement;
		const firstRun = !mountedRef.current;
		mountedRef.current = true;
		if (panelRef.current?.contains(active)) return;
		if (!firstRun && active && active !== document.body) return;
		panelButtons(panelRef.current)[0]?.focus({ preventScroll: true });
	}, [panelRef, visible, renderKey]);
}

interface DevServerListProps {
	position: { top: number; left: number };
	servers: Array<{ name: string; title: string; isDefault: boolean }>;
	status: DevServerStatus | null;
	busy: string | null;
	onStart: (name: string) => void;
	onStop: (name: string) => void;
	onRestart: (name: string) => void;
	onStartAll: () => void;
	onStopAll: () => void;
	onClose: () => void;
}

/**
 * One row per declared dev server: its state, the port it serves on, and its own
 * start/stop/restart. The toolbar keeps ONE button however many servers a
 * project declares — that is what this list is for.
 *
 * A stopped server's whole row is its Start button. A running row is NOT one
 * button: the only one-click action there would be Stop, which kills the user's
 * process, so it keeps separate Restart/Stop controls.
 */
function DevServerList({ position, servers, status, busy, onStart, onStop, onRestart, onStartAll, onStopAll, onClose }: DevServerListProps) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const argsKey = status?.servers.map((entry) => (entry.running ? formatDevServerArgs(entry.scriptArgs) : "")).join("\n");
	const { position: menuPos, visible } = useViewportClamp(menuRef, position, argsKey);

	useEscapeKey(onClose);
	useArrowKeyFocus(menuRef, visible, `${argsKey}|${status?.servers.map((entry) => entry.running).join(",")}|${busy}`);

	const anyRunning = status?.servers.some((entry) => entry.running) === true;

	return (
		<>
		<DismissBackdrop onClose={onClose} />
		<div
			ref={menuRef}
			data-testid="dev-server-list"
			role="group"
			aria-labelledby="dev-server-list-title"
			onKeyDown={(event) => moveFocusWithArrows(event, menuRef.current)}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[17rem] select-none"
			style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<div id="dev-server-list-title" className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("header.devServers")}
			</div>
			{servers.map((server) => {
				const entry = status?.servers.find((candidate) => candidate.name === server.name);
				const running = entry?.running === true;
				const port = entry?.devPorts[0]?.port ?? entry?.publishedPorts[0]?.port ?? null;
				const argsText = running && entry && entry.scriptArgs.length > 0 ? formatDevServerArgs(entry.scriptArgs) : null;
				const isBusy = busy === server.name;
				const dot = (
					<span
						className={`w-2 h-2 rounded-full flex-shrink-0 ${running ? "bg-success" : "bg-fg-muted/40"}`}
						aria-hidden
					/>
				);
				const name = <span className="flex-1 min-w-0 truncate text-sm text-fg-2 group-hover:text-fg" title={server.title}>{server.name}</span>;
				if (!running) {
					return (
						<button
							key={server.name}
							type="button"
							data-testid={`dev-server-row-${server.name}`}
							onClick={() => onStart(server.name)}
							disabled={isBusy}
							className={`group w-full flex items-center gap-x-2 px-3 py-1.5 text-left cursor-pointer hover:bg-fg/10 transition-colors disabled:cursor-progress disabled:opacity-60 ${FOCUS_ROW}`}
						>
							{dot}
							{name}
							<span className="text-xs text-fg-3 group-hover:text-fg group-focus-visible:text-fg">
								{isBusy ? t("header.devServerStarting") : t("header.devServerStart")}
							</span>
						</button>
					);
				}
				return (
					<div key={server.name} data-testid={`dev-server-row-${server.name}`} className="group flex flex-wrap items-center gap-x-2 px-3 py-1.5">
						{dot}
						{name}
						{port !== null && (
							<button
								type="button"
								onClick={() => window.open(`http://localhost:${port}`, "_blank")}
								className={`font-mono text-xs text-accent hover:text-accent-emphasis rounded ${FOCUS_CHIP}`}
								aria-label={t("header.devServerOpenPort", { port: String(port) })}
							>
								:{port}
							</button>
						)}
						<button
							type="button"
							onClick={() => onRestart(server.name)}
							disabled={isBusy}
							className={`text-xs text-fg-3 hover:text-fg px-1.5 py-0.5 rounded hover:bg-fg/10 disabled:opacity-40 ${FOCUS_CHIP}`}
						>
							{t("header.devServerRestart")}
						</button>
						<button
							type="button"
							onClick={() => onStop(server.name)}
							disabled={isBusy}
							className={`text-xs text-danger px-1.5 py-0.5 rounded hover:bg-fg/10 disabled:opacity-40 ${FOCUS_CHIP}`}
						>
							{t("header.devServerStop")}
						</button>
						{argsText !== null && (
							<div
								className="basis-full pl-4 font-mono text-xs text-fg-3 truncate"
								title={t("header.devServerArgsTitle", { args: argsText })}
								data-testid={`dev-server-args-${server.name}`}
							>
								{argsText}
							</div>
						)}
					</div>
				);
			})}
			{status && status.configErrors.length > 0 && (
				<p className="px-3 py-1.5 text-xs text-warning-strong">{status.configErrors.join("; ")}</p>
			)}
			<div className="mt-1 border-t border-edge pt-1 flex items-center gap-2 px-3 py-1">
				<button
					type="button"
					onClick={onStartAll}
					className={`text-xs text-fg-2 hover:text-fg px-1.5 py-0.5 rounded hover:bg-fg/10 ${FOCUS_CHIP}`}
				>
					{t("header.devServerStartAll")}
				</button>
				<button
					type="button"
					onClick={onStopAll}
					disabled={!anyRunning}
					className={`text-xs text-danger px-1.5 py-0.5 rounded hover:bg-fg/10 disabled:opacity-40 ${FOCUS_CHIP}`}
				>
					{t("header.devServerStopAll")}
				</button>
			</div>
		</div>
		</>
	);
}

export default function TaskDevServer({ task, project, isTaskActive, compact = false }: TaskDevServerProps) {
	const t = useT();
	const reducedMotion = useReducedMotion();
	const resolvedProject = useResolvedTaskProject(task, project);
	// The declared servers come from the same resolver the backend uses, so the
	// button can never disagree with what a start would actually do.
	const declaredServers = resolveDevServers(resolvedProject).servers;
	const hasDevScript = declaredServers.length > 0;
	const multiServer = declaredServers.length > 1;
	// The "setup-dev-server" control (§5.10) covers only the prompt shown for a
	// project with no dev script configured yet; a project that already has one
	// keeps the real running control — hiding never touches that toggle.
	const setupDevServerHidden = useIsControlHidden("setup-dev-server");
	const devServerBtnRef = useRef<HTMLButtonElement>(null);
	const devServerHintRef = useRef<HTMLDivElement>(null);
	const [devServerMenuOpen, setDevServerMenuOpen] = useState(false);
	const [devServerMenuPos, setDevServerMenuPos] = useState({ top: 0, left: 0 });
	const [devServerHintOpen, setDevServerHintOpen] = useState(false);
	const [devServerHintCopied, setDevServerHintCopied] = useState(false);
	const [devServerHintPos, setDevServerHintPos] = useState({ top: 0, left: 0 });
	const [devState, setDevState] = useState<DevServerState>("unknown");
	const [devServerListOpen, setDevServerListOpen] = useState(false);
	const [devServerListPos, setDevServerListPos] = useState({ top: 0, left: 0 });
	const [devStatus, setDevStatus] = useState<DevServerStatus | null>(null);
	const [busyServer, setBusyServer] = useState<string | null>(null);

	async function refreshDevStatus() {
		try {
			const status = await api.request.getDevServerStatus({ taskId: task.id, projectId: project.id });
			setDevStatus(status);
			setDevState(status.running ? "running" : "stopped");
		} catch (err) {
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	function openDevServerList() {
		if (devServerBtnRef.current) {
			const rect = devServerBtnRef.current.getBoundingClientRect();
			setDevServerListPos({ top: rect.bottom + 4, left: rect.left });
		}
		setDevServerListOpen(true);
		void refreshDevStatus();
	}

	/** One server's start/stop/restart from the list, then a fresh read. */
	async function actOnServer(action: "start" | "stop" | "restart", server?: string, all?: boolean) {
		setBusyServer(server ?? "*");
		try {
			const params = { taskId: task.id, projectId: project.id, ...(server ? { server } : {}), ...(all ? { all: true } : {}) };
			const status = action === "start"
				? await api.request.runDevServer(params)
				: action === "stop"
					? await api.request.stopDevServer(params)
					: await api.request.restartDevServer(params);
			setDevStatus(status);
			setDevState(status.running ? "running" : "stopped");
		} catch (err) {
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
			void refreshDevStatus();
		} finally {
			setBusyServer(null);
		}
	}

	// settle-to-render has to be measured AFTER React commits, not after the setState
	// call returns — otherwise it reports the time to schedule a render, which is
	// always near zero and says nothing about what the user saw (seq 1407).
	// Each intent names the task and the state it expects to see painted. Two intents
	// batched into ONE commit did not produce two paints, so only the boundary whose
	// state actually got committed is reported and a superseded optimistic intent is
	// dropped — reporting both against the same devState would invent a paint.
	const pendingRendersRef = useRef<
		Array<{ trace: DevServerTrace; boundary: RenderBoundary; taskId: string; expected: DevServerState }>
	>([]);
	function markRendered(trace: DevServerTrace, boundary: RenderBoundary, expected: DevServerState) {
		pendingRendersRef.current.push({ trace, boundary, taskId: task.id, expected });
	}
	useEffect(() => {
		const pending = pendingRendersRef.current;
		if (pending.length === 0) return;
		// An intent armed for another task must never be flushed against this one's
		// state; it describes a view that is no longer on screen.
		const stale = pending.filter((entry) => entry.taskId !== task.id);
		const mine = pending.filter((entry) => entry.taskId === task.id);
		pendingRendersRef.current = [];
		void stale;
		// Only the LAST intent whose expected state matches what was committed describes
		// a real paint; anything before it was superseded inside the same commit.
		const painted = mine.filter((entry) => entry.expected === devState);
		const winner = painted[painted.length - 1];
		if (!winner) return;
		if (winner.boundary === "optimistic") winner.trace.optimisticRendered(devState);
		else winner.trace.rendered(devState);
	}, [devState, task.id]);

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
		const taskId = task.id;
		let ownTrace: DevServerTrace | null = null;
		async function poll() {
			// Join whatever is already outstanding for THIS task rather than issuing a
			// second request; a remount must not double up on a hung bridge.
			const existing = devServerPollsInFlight.get(taskId);
			if (existing) {
				await existing.catch(() => {});
				return;
			}
			const trace = traceDevServerOp("checkDevServer", taskId);
			ownTrace = trace;
			const request = api.request.checkDevServer({
				taskId,
				projectId: project.id,
				opId: trace.opId,
			});
			devServerPollsInFlight.set(taskId, request);
			try {
				trace.sent();
				const res = await request;
				trace.settled();
				// A late settle for a view that is gone must not write state either.
				if (cancelled) return;
				setDevState((prev) => (prev === "starting" ? prev : res?.running ? "running" : "stopped"));
			} catch (err) {
				// Keep the last known state on a transient RPC error.
				trace.rejected(err);
			} finally {
				if (devServerPollsInFlight.get(taskId) === request) devServerPollsInFlight.delete(taskId);
				if (ownTrace === trace) ownTrace = null;
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
			// Cancels the whole trace, not just its timer: a request that settles or
			// rejects after this view is gone must emit nothing.
			ownTrace?.cancel();
			ownTrace = null;
		};
	}, [task.id, project.id, hasDevScript, isTaskActive]);

	function openDevServerMenu() {
		if (devServerBtnRef.current) {
			const rect = devServerBtnRef.current.getBoundingClientRect();
			setDevServerMenuPos({ top: rect.bottom + 4, left: rect.left });
		}
		setDevServerMenuOpen(true);
		void loadMenuStatus();
	}

	/** Fills the menu's args line; display only, so a failed read just leaves it out. */
	async function loadMenuStatus() {
		try {
			setDevStatus((await api.request.getDevServerStatus({ taskId: task.id, projectId: project.id })) ?? null);
		} catch {
			// no args line
		}
	}

	async function startDevServerNow() {
		const trace = traceDevServerOp("runDevServer", task.id);
		setDevState("starting");
		markRendered(trace, "optimistic", "starting");
		try {
			trace.sent();
			const status = await api.request.runDevServer({
				taskId: task.id,
				projectId: project.id,
				opId: trace.opId,
			});
			trace.settled();
			const next = status?.running === false ? "stopped" : "running";
			setDevState(next);
			markRendered(trace, "settled", next);
		} catch (err) {
			trace.rejected(err);
			setDevState("stopped");
			markRendered(trace, "settled", "stopped");
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

		// The trigger toggles: a second press closes whichever panel it opened.
		if (devServerListOpen || devServerMenuOpen) {
			setDevServerListOpen(false);
			setDevServerMenuOpen(false);
			return;
		}

		// Several declared servers cannot be collapsed into one click: which one
		// would it start? The list is the control.
		if (multiServer) {
			openDevServerList();
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
		const trace = traceDevServerOp("stopDevServer", task.id);
		setDevServerMenuOpen(false);
		// The UI reports "stopped" before the backend confirms it, so this paint is
		// optimistic and is measured from the gesture — there is no settle to measure
		// from yet, and the trace is the only record of whether the request landed.
		setDevState("stopped");
		markRendered(trace, "optimistic", "stopped");
		try {
			trace.sent();
			await api.request.stopDevServer({ taskId: task.id, projectId: project.id, opId: trace.opId });
			trace.settled();
		} catch (err) {
			trace.rejected(err);
			toast.error(t("infoPanel.devServerFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	// Copied for an agent to run, so it stays English in every locale — the same
	// reason `bugHunters.nextPrompt` does. Not an untranslated string.
	const devServerHintPrompt = t("header.devServerHintPrompt");

	// Active + has-script states drive the glanceable running indicator. Green
	// (success token) means running ONLY; stopped is neutral; the spinner is
	// reserved for the transient starting phase (never a steady "running" signal).
	const isRunning = hasDevScript && isTaskActive && devState === "running";
	const isStarting = hasDevScript && isTaskActive && devState === "starting";

	const stateClasses = !hasDevScript
		? "text-warning-strong hover:bg-warning/15 cursor-pointer border border-dashed border-warning/40"
		: !isTaskActive
			? "text-fg-muted/50 cursor-not-allowed border border-transparent"
			: isStarting
				? "text-fg-3 border border-edge cursor-progress"
				: isRunning
					? "text-success hover:bg-success/15 border border-success/30"
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
					className={`w-3.5 h-3.5 rounded-full border-2 border-[color-mix(in_srgb,currentColor_30%,transparent)] border-t-current${reducedMotion ? "" : " animate-spin"}`}
				/>
			</span>
		);
	} else if (hasDevScript && isTaskActive) {
		// Stopped (or not-yet-resolved): a "start" play affordance.
		devServerIcon = <PlayIcon className="w-[1.125rem] h-[1.125rem]" />;
	} else {
		// No-script / inactive: the original neutral arrow.
		devServerIcon = <SetupArrowIcon className="w-[1.125rem] h-[1.125rem]" />;
	}

	// All hooks above have already run — safe to bail on JSX only. Only the
	// no-devScript prompt is hideable; the real running control never is.
	if (setupDevServerHidden && !hasDevScript) return null;

	const content = (
		<>
			<Tooltip content={devServerTitle} detail={devServerDetail}>
				<button
					ref={devServerBtnRef}
					onClick={handleDevServer}
					className={`task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${stateClasses}`}
					aria-label={devServerTitle}
					aria-busy={isStarting}
					aria-haspopup={hasDevScript && isTaskActive && (multiServer || isRunning) ? "true" : undefined}
					aria-expanded={devServerListOpen || devServerMenuOpen}
					data-tour-anchor="task.dev-server"
				>
					{devServerIcon}
					{!compact && <span className="text-micro font-semibold">{devServerLabel}</span>}
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
							className="flex-shrink-0 px-2 py-1.5 rounded text-xs bg-accent-fill hover:bg-accent-fill-hover text-white transition-colors"
						>
							<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{devServerHintCopied ? "\uF00C" : "\uF0C5"}
							</span>
						</button>
					</div>
				</div>,
				document.body,
			)}

			{devServerListOpen && createPortal(
				<DevServerList
					position={devServerListPos}
					servers={declaredServers}
					status={devStatus}
					busy={busyServer}
					onStart={(name) => actOnServer("start", name)}
					onStop={(name) => actOnServer("stop", name)}
					onRestart={(name) => actOnServer("restart", name)}
					onStartAll={() => actOnServer("start", undefined, true)}
					onStopAll={() => actOnServer("stop", undefined, true)}
					onClose={() => {
						setDevServerListOpen(false);
						devServerBtnRef.current?.focus();
					}}
				/>,
				document.body,
			)}

			{devServerMenuOpen && createPortal(
				<DevServerMenu
					position={devServerMenuPos}
					scriptArgs={devStatus?.servers.find((entry) => entry.running)?.scriptArgs ?? []}
					onRestart={handleDevServerRestart}
					onStop={handleDevServerStop}
					onClose={() => {
						setDevServerMenuOpen(false);
						devServerBtnRef.current?.focus();
					}}
				/>,
				document.body,
			)}
		</>
	);

	return hasDevScript ? content : <HideableControl id="setup-dev-server">{content}</HideableControl>;
}
