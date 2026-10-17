import type { TmuxLayout, TmuxSessionInfo, TmuxWindowEntry } from "../../../shared/types";
import { getTaskTitle } from "../../../shared/types";
import * as data from "../../data";
import * as pty from "../../pty-server";
import { getPortsForTask } from "../../port-scanner";
import { boostResourceMonitor, clearResourceMonitorBoost, getResourceUsage } from "../../resource-monitor";
import { tmux, DEFAULT_TMUX_SOCKET, TmuxError, devServerSessionName, devServerSessionForTaskSession, parseDev3SessionName, PANE_CWD_FORMAT, PANE_ID_FORMAT, PANE_IN_MODE_FORMAT, PANE_SWITCHER_FORMAT, WINDOW_SWITCHER_FORMAT, WINDOW_PANE_FORMAT, TMUX_LAST_AGENT_PANE_OPTION, SEARCH_STATE_FORMAT, SESSION_OVERVIEW_FORMAT, ALT_CLICK_PANE_FORMAT, altClickIneligibleReason, clientCellToWindowCell, computeAltClickKeys, findAltClickPane, validAltClickPanes } from "../../tmux";
import { buildWindowEntries } from "../../tmux/window-nav";
import { log } from "../shared-pure";
import { collectDevServerTreePids, reapDevServerTree } from "./dev-servers";
import { handlePaneExited } from "./task-launch";

export async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
	log.debug("→ listTmuxSessions");

	let sessionRows: Array<{ name: string; windowCount: number; createdAt: number; cwd: string }>;
	try {
		sessionRows = await tmux.listSessions(SESSION_OVERVIEW_FORMAT);
	} catch {
		log.debug("← listTmuxSessions (no tmux server or error)");
		return [];
	}

	const taskShortIds = new Set<string>();
	const projectShortIds = new Set<string>();
	const rawSessions: Array<{
		name: string;
		cwd: string;
		createdAt: number;
		windowCount: number;
		isCleanup: boolean;
		isProjectTerminal: boolean;
		shortId: string;
	}> = [];

	for (const row of sessionRows) {
		const parsed = parseDev3SessionName(row.name);
		if (!parsed) continue;
		if (parsed.kind === "dev-server") continue;
		// Ignore a stale single home terminal session from an older app version
		// (the home terminal was replaced by the Quick-shell operation).
		if (row.name === "dev3-home") continue;

		const isCleanup = parsed.kind === "cleanup";
		const isProjectTerminal = parsed.kind === "project-terminal";

		rawSessions.push({
			name: row.name,
			cwd: row.cwd || "",
			createdAt: row.createdAt,
			windowCount: row.windowCount || 1,
			isCleanup,
			isProjectTerminal,
			shortId: parsed.shortId,
		});

		if (isProjectTerminal) {
			projectShortIds.add(parsed.shortId);
		} else {
			taskShortIds.add(parsed.shortId);
		}
	}

	if (rawSessions.length === 0) {
		log.debug("← listTmuxSessions", { count: 0 });
		return [];
	}

	const taskMap = new Map<string, { title: string; taskId: string; projectId: string }>();
	const projectMap = new Map<string, { name: string; projectId: string }>();
	try {
		// Include virtual ("Operations") projects so their operation sessions resolve too.
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		const pendingTaskIds = new Set(taskShortIds);

		for (const project of projects) {
			const shortProjectId = project.id.slice(0, 8);
			if (projectShortIds.has(shortProjectId)) {
				projectMap.set(shortProjectId, { name: project.name, projectId: project.id });
			}

			if (pendingTaskIds.size === 0) {
				if (projectMap.size === projectShortIds.size) break;
				continue;
			}

			const tasks = await data.loadTasks(project);
			for (const task of tasks) {
				const shortTaskId = task.id.slice(0, 8);
				if (!pendingTaskIds.has(shortTaskId)) continue;
				taskMap.set(shortTaskId, {
					title: getTaskTitle(task),
					taskId: task.id,
					projectId: project.id,
				});
				pendingTaskIds.delete(shortTaskId);
			}

			if (pendingTaskIds.size === 0 && projectMap.size === projectShortIds.size) break;
		}
	} catch {}

	const sessions: TmuxSessionInfo[] = [];
	for (const rawSession of rawSessions) {
		const { name, cwd, windowCount, createdAt, isCleanup, isProjectTerminal, shortId } = rawSession;
		if (isProjectTerminal) {
			const projectInfo = projectMap.get(shortId);
			sessions.push({
				name,
				cwd,
				createdAt,
				windowCount,
				isCleanup: false,
				isProjectTerminal: true,
				projectName: projectInfo?.name,
				projectId: projectInfo?.projectId,
			});
			continue;
		}

		const taskInfo = taskMap.get(shortId);

		sessions.push({
			name,
			cwd,
			createdAt,
			windowCount,
			isCleanup,
			taskTitle: taskInfo?.title,
			taskId: taskInfo?.taskId,
			projectId: taskInfo?.projectId,
			ports: taskInfo?.taskId ? getPortsForTask(taskInfo.taskId) : undefined,
			resourceUsage: taskInfo?.taskId ? getResourceUsage(taskInfo.taskId) : undefined,
		});
	}

	sessions.sort((a, b) => b.createdAt - a.createdAt);
	log.debug("← listTmuxSessions", { count: sessions.length });
	return sessions;
}

/**
 * Renewed on a heartbeat while the tmux sessions popover is open, cleared when
 * it closes. See the boost's own TTL — this handler never has to be trusted to
 * send the `false`.
 */
export async function setResourceMonitorBoost(params: { active: boolean }): Promise<void> {
	if (params.active) boostResourceMonitor();
	else clearResourceMonitorBoost();
}

export async function killTmuxSession(params: { sessionName: string }): Promise<void> {
	log.info("→ killTmuxSession", { sessionName: params.sessionName });
	if (!params.sessionName.startsWith("dev3-")) {
		throw new Error("Can only kill dev3-* sessions");
	}
	try {
		await tmux.killSession(params.sessionName);
	} catch (err) {
		const stderr = err instanceof TmuxError ? err.stderr : String(err);
		log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr });
		throw new Error(`Failed to kill session: ${stderr}`);
	}

	if (!params.sessionName.startsWith("dev3-dev-")) {
		const devSession = devServerSessionForTaskSession(params.sessionName);
		// Same orphaned-children problem as the Stop button: snapshot the dev
		// server's process tree before tearing the session down, then reap it
		// with verification. (No full task ID here, so the port-ownership orphan
		// sweep is skipped — the tree reap covers the common case.)
		const treePids = await collectDevServerTreePids(devSession, DEFAULT_TMUX_SOCKET);
		await tmux.killSession(devSession, { bestEffort: true });
		await reapDevServerTree(treePids, devSession);
		log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
	}

	log.info("← killTmuxSession done", { sessionName: params.sessionName });
}

export async function tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV"; force?: boolean }): Promise<void> {
	log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action, force: params.force === true });
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	// For killPane, capture the active pane ID before killing — kill-pane
	// does NOT trigger tmux's pane-exited hook, so we must clean up sessionState here.
	// By default refuse to kill the last remaining pane in the session — otherwise an
	// accidental click on the red button takes down the agent's own pane. The frontend
	// can pass `force: true` after explicit user confirmation to allow it.
	let killedPaneId: string | null = null;
	if (params.action === "killPane") {
		if (!params.force) {
			try {
				const paneCount = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
				if (paneCount <= 1) {
					log.info("tmuxAction killPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
					return;
				}
			} catch { /* best effort — if counting fails, fall through to the normal kill */ }
		}

		try {
			killedPaneId = await tmux.activePaneId(tmuxSession, { socket });
		} catch { /* best effort */ }
	}

	try {
		switch (params.action) {
			case "splitH":
				await tmux.splitWindow({ target: tmuxSession, orientation: "vertical", cwd: PANE_CWD_FORMAT, socket });
				break;
			case "splitV":
				await tmux.splitWindow({ target: tmuxSession, orientation: "horizontal", cwd: PANE_CWD_FORMAT, socket });
				break;
			case "zoom":
				await tmux.toggleZoom(tmuxSession, { socket });
				break;
			case "killPane":
				await tmux.killPane(tmuxSession, { socket });
				break;
			case "nextPane":
				await tmux.selectPane(`${tmuxSession}:.+`, { socket });
				break;
			case "prevPane":
				await tmux.selectPane(`${tmuxSession}:.-`, { socket });
				break;
			case "newWindow":
				await tmux.newWindow({ target: tmuxSession, cwd: PANE_CWD_FORMAT, focus: true, socket });
				break;
			case "nextLayout":
				await tmux.nextLayout(tmuxSession, { socket });
				break;
			case "layoutTiled":
				await tmux.selectLayout(tmuxSession, "tiled", { socket });
				break;
			case "layoutEvenH":
				await tmux.selectLayout(tmuxSession, "even-vertical", { socket });
				break;
			case "layoutEvenV":
				await tmux.selectLayout(tmuxSession, "even-horizontal", { socket });
				break;
			case "layoutMainH":
				await tmux.selectLayout(tmuxSession, "main-horizontal", { socket });
				break;
			case "layoutMainV":
				await tmux.selectLayout(tmuxSession, "main-vertical", { socket });
				break;
		}
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("tmuxAction failed", { action: params.action, exitCode: err.exitCode, stderr: err.stderr });
		throw new Error(`tmux ${params.action} failed: ${err.stderr || "unknown error"}`);
	}

	// Remove killed pane from sessionState
	if (params.action === "killPane" && killedPaneId) {
		handlePaneExited(params.taskId, killedPaneId).catch((err) => {
			log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
		});
	}

	log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
}

export async function tmuxPaneCount(params: { taskId: string }): Promise<{ count: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	try {
		const count = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
		return { count };
	} catch {
		return { count: 0 };
	}
}

/**
 * Kill ONE specific pane by its tmux id (`%N`) — the target the two-step close-
 * pane picker committed to. Unlike {@link tmuxAction}'s `killPane` (which kills
 * whatever tmux thinks is active), this closes exactly the hovered pane the user
 * clicked, regardless of which pane is currently focused.
 *
 * Mirrors the killPane guards: refuse to kill the last pane in the session unless
 * `force` is set (the frontend confirms first, since that tears down the agent's
 * own session), and clean up sessionState via handlePaneExited (kill-pane does
 * not fire tmux's pane-exited hook).
 */
export async function tmuxKillPane(params: { taskId: string; paneId: string; force?: boolean }): Promise<{ killed: boolean }> {
	log.info("→ tmuxKillPane", { taskId: params.taskId.slice(0, 8), paneId: params.paneId, force: params.force === true });
	// The pane id always originates from our own tmuxLayout (`%N`); validate the
	// shape defensively before it reaches a spawn arg.
	if (!/^%\d+$/.test(params.paneId)) {
		log.warn("tmuxKillPane rejected — malformed pane id", { paneId: params.paneId });
		return { killed: false };
	}

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	if (!params.force) {
		try {
			const paneCount = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
			if (paneCount <= 1) {
				log.info("tmuxKillPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
				return { killed: false };
			}
		} catch { /* best effort — if counting fails, fall through to the normal kill */ }
	}

	try {
		await tmux.killPane(params.paneId, { socket });
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("tmuxKillPane failed", { paneId: params.paneId, exitCode: err.exitCode, stderr: err.stderr });
		throw new Error(`tmux kill-pane failed: ${err.stderr || "unknown error"}`);
	}

	// kill-pane does NOT trigger tmux's pane-exited hook, so clean up sessionState here.
	handlePaneExited(params.taskId, params.paneId).catch((err) => {
		log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
	});

	log.info("← tmuxKillPane done", { taskId: params.taskId.slice(0, 8), paneId: params.paneId });
	return { killed: true };
}

export interface PaneLayoutInfo {
	count: number;
	activeIndex: number;
	zoomed: boolean;
	paneIds: string[];
	labels: string[];
}

/**
 * Read the current window's pane layout (window-scoped, NOT `-s`): how many
 * panes, which one is active (by display order), whether the window is zoomed,
 * each pane's id, and a human label per pane. Drives the narrow-viewport pane
 * switcher. Returns an empty layout when the session is gone or tmux errors.
 *
 * Label = an explicitly-set pane title (dev3 names some panes "Agent" / "Shell"
 * / "Dev Server") — but tmux defaults pane_title to the hostname, so a title
 * equal to host_short is treated as unset — else the running command, else "".
 * The frontend localises the empty fallback to "Pane N".
 */
export async function readPaneLayout(socket: string, tmuxSession: string): Promise<PaneLayoutInfo> {
	try {
		const rows = await tmux.listPanes(PANE_SWITCHER_FORMAT, { target: tmuxSession, socket });
		const paneIds: string[] = [];
		const labels: string[] = [];
		let activeIndex = 0;
		let zoomed = false;
		rows.forEach((row, i) => {
			paneIds.push(row.paneId);
			const trimmedTitle = row.title.trim();
			const meaningfulTitle = trimmedTitle && trimmedTitle !== row.hostShort.trim() ? trimmedTitle : "";
			labels.push(meaningfulTitle || row.command.trim() || "");
			if (row.active) {
				activeIndex = i;
				zoomed = row.zoomed;
			}
		});
		return { count: rows.length, activeIndex, zoomed, paneIds, labels };
	} catch {
		return { count: 0, activeIndex: 0, zoomed: false, paneIds: [], labels: [] };
	}
}

/**
 * Pane navigation for the narrow-viewport pane carousel. In one round trip it
 * can select the next/prev/absolute pane AND enforce a zoom intent, then return
 * the fresh layout for the pager UI.
 *
 * The tmux gotcha (doctrine §6.3): `select-pane` auto-unzooms the window. So a
 * "keep zoom" step must select first, then re-zoom. We make zooming idempotent
 * (read the flag, toggle only on a mismatch) so a doubled call — React Strict
 * Mode, a retry, a poll racing a tap — never flips zoom the wrong way.
 */
export async function tmuxPaneNavigate(params: {
	taskId: string;
	step?: "next" | "prev";
	index?: number;
	paneId?: string;
	zoom?: boolean;
}): Promise<{ count: number; activeIndex: number; zoomed: boolean; labels: string[] }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	let info = await readPaneLayout(socket, tmuxSession);
	if (info.count === 0) return { count: 0, activeIndex: 0, zoomed: false, labels: [] };

	// Navigate (only meaningful with more than one pane).
	if (info.count > 1) {
		let navigated = false;
		if (params.step === "next") {
			await tmux.selectPane(`${tmuxSession}:.+`, { socket, bestEffort: true });
			navigated = true;
		} else if (params.step === "prev") {
			await tmux.selectPane(`${tmuxSession}:.-`, { socket, bestEffort: true });
			navigated = true;
		} else if (typeof params.index === "number" && info.paneIds[params.index]) {
			await tmux.selectPane(info.paneIds[params.index], { socket, bestEffort: true });
			navigated = true;
		} else if (params.paneId && info.paneIds.includes(params.paneId)) {
			// Jump-by-id (the pane-map sheet taps a specific box). Robust against
			// any index/order drift between the map's layout and this read.
			await tmux.selectPane(params.paneId, { socket, bestEffort: true });
			navigated = true;
		}
		// Re-read after a move: select-pane changes the active pane AND auto-unzooms.
		if (navigated) info = await readPaneLayout(socket, tmuxSession);
	}

	// Enforce zoom intent idempotently (single pane needs no zoom — it already fills the window).
	let zoomed = info.zoomed;
	if (info.count > 1 && typeof params.zoom === "boolean" && params.zoom !== info.zoomed) {
		await tmux.toggleZoom(tmuxSession, { socket, bestEffort: true });
		zoomed = params.zoom;
	}

	log.info("← tmuxPaneNavigate", {
		taskId: params.taskId.slice(0, 8),
		step: params.step ?? "none",
		index: params.index ?? -1,
		count: info.count,
		activeIndex: info.activeIndex,
		zoomed,
	});
	return { count: info.count, activeIndex: info.activeIndex, zoomed, labels: info.labels };
}

/**
 * Snapshot the full tmux layout (windows + every pane's geometry) for a task's
 * session. Powers the narrow-viewport "zoom-out" pane-map sheet — the same data
 * `dev3 ui state` renders as ASCII boxes. Reuses the session's own socket so it
 * also works for the rare non-default socket.
 */
export async function tmuxLayout(params: { taskId: string }): Promise<TmuxLayout> {
	const socket = pty.getSessionSocket(params.taskId);
	return pty.getTmuxLayout(params.taskId, socket);
}

/**
 * Read a session's windows for the in-app window navigator (desktop rail/tabs,
 * narrow switcher): identity, display label, which one is active, which one is
 * the agent's home, and the background signals (last output, bell). Returns []
 * when the session is gone or tmux errors.
 */
async function readWindowEntries(socket: string, tmuxSession: string): Promise<TmuxWindowEntry[]> {
	try {
		const [rows, agentPanes, lastAgentPane] = await Promise.all([
			tmux.listWindows(WINDOW_SWITCHER_FORMAT, { target: tmuxSession, socket }),
			tmux.listPanes(WINDOW_PANE_FORMAT, { target: tmuxSession, scope: "session", socket }).catch(() => []),
			tmux.showOption(tmuxSession, TMUX_LAST_AGENT_PANE_OPTION, { socket }).catch(() => ""),
		]);
		return buildWindowEntries(rows, agentPanes, lastAgentPane || null);
	} catch {
		return [];
	}
}

/**
 * Window navigation for the window navigator. In one round trip it selects the
 * next/prev window or a window by its stable id, then returns the fresh list.
 * No step and no id is a plain read (the navigator's poll).
 */
export async function tmuxWindowNavigate(params: {
	taskId: string;
	step?: "next" | "prev";
	windowId?: string;
}): Promise<{ windows: TmuxWindowEntry[] }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	let windows = await readWindowEntries(socket, tmuxSession);
	if (windows.length > 1) {
		// `:+` / `:-` are the next / previous window and wrap around.
		const target = params.step === "next"
			? `${tmuxSession}:+`
			: params.step === "prev"
				? `${tmuxSession}:-`
				: windows.find((w) => w.windowId === params.windowId)?.windowId;
		if (target) {
			await tmux.selectWindow(target, { socket, bestEffort: true });
			windows = await readWindowEntries(socket, tmuxSession);
			log.info("← tmuxWindowNavigate", {
				taskId: params.taskId.slice(0, 8),
				step: params.step ?? "id",
				count: windows.length,
				active: windows.findIndex((w) => w.active),
			});
		}
	}
	return { windows };
}

/**
 * iTerm2-style Alt/Option-click: walk the shell cursor to the clicked cell.
 *
 * The renderer cannot gate this on `hasMouseTracking()` — dev3's tmux runs
 * with `mouse on`, which keeps the OUTER terminal's mouse tracking enabled
 * for the whole session, plain shell or not (decision 098). So the renderer
 * forwards the clicked cell here, and tmux is asked what actually runs in
 * that pane: only plain shells (zsh/bash/fish/…) get arrow keys; TUIs that
 * own the mouse (Claude Code, vim, htop) are left untouched — the alt-click
 * SGR event reaches them via the normal mouse pass-through instead.
 *
 * col/row are 1-based cells of the outer terminal grid. All decision logic
 * is pure and unit-tested in ../tmux-alt-click.ts.
 */
export async function tmuxAltClickMoveCursor(params: { taskId: string; col: number; row: number }): Promise<{ moved: boolean }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	const cell = clientCellToWindowCell(params.col, params.row, await pty.readTmuxStatusGeometry(tmuxSession, socket));
	if (!cell) return { moved: false };
	const { x0, y0 } = cell;

	// Panes of the session's CURRENT window only (that's what the client shows).
	let panes;
	try {
		panes = validAltClickPanes(await tmux.listPanes(ALT_CLICK_PANE_FORMAT, { target: tmuxSession, socket }));
	} catch {
		return { moved: false };
	}

	const pane = findAltClickPane(panes, x0, y0);
	if (!pane) return { moved: false };

	const reason = altClickIneligibleReason(pane);
	if (reason) {
		log.debug("tmuxAltClickMoveCursor skipped", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, reason });
		return { moved: false };
	}

	// Row text of the cursor line — clamps the target to end-of-input so a
	// click in the blank area right of the text lands exactly at EOL.
	let rowText = "";
	try {
		const capOut = await tmux.capturePane({
			target: pane.paneId,
			startLine: pane.cursorY,
			endLine: pane.cursorY,
			socket,
		});
		rowText = capOut.replace(/\n$/, "");
	} catch {
		// Capture failed — fall back to an empty row (clamps to column 0).
	}

	const plan = computeAltClickKeys(pane, x0, y0, rowText);
	if (!plan) return { moved: false };

	// Focus the clicked pane (alt-clicks bypass tmux's own MouseDown1Pane
	// select-pane binding). Skip when already active — select-pane would
	// needlessly unzoom a zoomed window (see tmuxPaneNavigate gotcha).
	if (!pane.active) {
		await tmux.selectPane(pane.paneId, { socket, bestEffort: true });
	}
	await tmux.sendKeys(pane.paneId, Array<string>(plan.count).fill(plan.key), { socket, bestEffort: true });
	log.info("← tmuxAltClickMoveCursor", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, key: plan.key, count: plan.count });
	return { moved: true };
}

/**
 * Every tmux session whose panes a terminal key owns: the session itself, plus
 * the task's detached dev-server sibling (the window users most often scroll).
 * Registry-aware, so a quick shell resolves to its own `dev3-pt-<id>` instead of
 * a task name that cannot exist — asking `tmuxSessionExists` here reported "no
 * session" for every quick shell and made copy-mode invisible there.
 */
async function copyModeSessions(key: string, socket: string): Promise<string[]> {
	const found: string[] = [];
	const own = pty.getSessionTmuxName(key);
	if (await tmux.hasSession(own, { socket })) found.push(own);
	if (pty.isProjectSessionKey(key)) return found;
	const devSession = devServerSessionName(key);
	if (await tmux.hasSession(devSession, { socket })) found.push(devSession);
	return found;
}

async function exitCopyModeInSession(socket: string, tmuxSession: string): Promise<number> {
	let panesInMode: string[];
	try {
		const rows = await tmux.listPanes(PANE_IN_MODE_FORMAT, { target: tmuxSession, scope: "session", socket });
		panesInMode = rows.filter((row) => row.paneId && row.inMode).map((row) => row.paneId);
	} catch (err) {
		if (err instanceof TmuxError) return 0;
		throw err;
	}

	for (const paneId of panesInMode) {
		await tmux.exitCopyMode(paneId, { socket, bestEffort: true });
	}

	return panesInMode.length;
}

/**
 * Is any pane of the task's tmux session still in copy-mode? The touch
 * scroll-to-latest button polls this while it believes the pane is scrolled
 * into history: tmux leaves copy-mode on its own when a swipe reaches the
 * bottom, and the renderer has no other way to notice.
 */
export async function tmuxPanesInMode(params: { taskId: string }): Promise<{ inMode: boolean }> {
	const socket = pty.getSessionSocket(params.taskId);
	for (const session of await copyModeSessions(params.taskId, socket)) {
		try {
			const rows = await tmux.listPanes(PANE_IN_MODE_FORMAT, { target: session, scope: "session", socket });
			if (rows.some((row) => row.paneId && row.inMode)) return { inMode: true };
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
		}
	}
	return { inMode: false };
}

export async function exitCopyModeAllPanes(params: { taskId: string }): Promise<{ panesExited: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	// Copy mode is a tmux concept, so a native task owns no session here and this
	// whole handler is a no-op for it.
	const sessions = await copyModeSessions(params.taskId, socket);

	let total = 0;
	for (const session of sessions) {
		total += await exitCopyModeInSession(socket, session);
	}

	if (total > 0) {
		log.info("Exited copy-mode in panes", { taskId: params.taskId.slice(0, 8), count: total, sessions });
	}
	return { panesExited: total };
}

// ── Terminal ⌘F search (tmux copy-mode search) ─────────────────────────
//
// The scrollback lives inside tmux (mouse-mode on → wheel scroll is SGR mouse,
// ghostty's own buffer only holds the visible screen), so search runs in tmux
// copy-mode: tmux highlights every match in the pane content and the picture
// streams back through the PTY for free. See decision 141.

const SEARCH_PANE_ID_RE = /^%\d+$/;

async function searchMatchCount(paneId: string, socket: string): Promise<number> {
	const state = await tmux.displayMessage(SEARCH_STATE_FORMAT, { target: paneId, socket });
	// search_count is stale after a miss — search_present gates it (see formats.ts).
	return state?.present ? state.count : 0;
}

/**
 * Set (or clear) the search query in one pane. The first call resolves the
 * session's active pane and returns its id; later calls pass that id back so
 * the search stays pinned to one pane even if tmux focus moves. Every query
 * re-anchors at history-bottom — plain `search-backward` searches up from the
 * CURRENT cursor, so incremental typing would otherwise drift the match
 * further up with each keystroke (verified live, decision 141).
 * Returns `paneId: null` when the target pane is gone — the caller should
 * re-resolve on the next update.
 */
export async function tmuxSearchUpdate(params: { taskId: string; query: string; paneId?: string }): Promise<{ paneId: string | null; matches: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	if (params.paneId !== undefined && !SEARCH_PANE_ID_RE.test(params.paneId)) {
		log.warn("tmuxSearchUpdate rejected — malformed pane id", { paneId: params.paneId });
		return { paneId: null, matches: 0 };
	}

	let paneId = params.paneId ?? null;
	try {
		if (!paneId) paneId = await tmux.activePaneId(tmuxSession, { socket });
		if (!paneId) return { paneId: null, matches: 0 };

		if (!params.query) {
			// Cleared query — drop the highlight and unfreeze the pane.
			await tmux.exitCopyMode(paneId, { socket, bestEffort: true });
			return { paneId, matches: 0 };
		}

		await tmux.enterCopyMode(paneId, { socket });
		await tmux.copyModeHistoryBottom(paneId, { socket });
		await tmux.copyModeSearchBackwardText(paneId, params.query, { socket });
		return { paneId, matches: await searchMatchCount(paneId, socket) };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		// Pane died mid-search — tell the frontend to re-resolve.
		log.info("tmuxSearchUpdate target gone", { taskId: params.taskId.slice(0, 8), paneId, stderr: err.stderr });
		return { paneId: null, matches: 0 };
	}
}

/** Step to the next match: "older" walks up the history, "newer" back down. */
export async function tmuxSearchStep(params: { taskId: string; paneId: string; direction: "older" | "newer" }): Promise<{ matches: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	if (!SEARCH_PANE_ID_RE.test(params.paneId)) return { matches: 0 };
	try {
		await tmux.copyModeSearchStep(params.paneId, params.direction, { socket });
		return { matches: await searchMatchCount(params.paneId, socket) };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		return { matches: 0 };
	}
}

/** Close the search: leave copy-mode so the pane resumes live output. */
export async function tmuxSearchCancel(params: { taskId: string; paneId: string }): Promise<void> {
	const socket = pty.getSessionSocket(params.taskId);
	if (!SEARCH_PANE_ID_RE.test(params.paneId)) return;
	await tmux.exitCopyMode(params.paneId, { socket, bestEffort: true });
}
