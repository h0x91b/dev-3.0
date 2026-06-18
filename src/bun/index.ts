import Electrobun, {
	ApplicationMenu,
	PATHS,
	Updater,
	Utils,
} from "electrobun/bun";
import { handlers, setPushMessage, getPushMessage, handleBellAutoStatus, isTaskInProgress, startMergeDetectionPoller, startPRDetectionPoller, handlePaneExited, consumeRecentWatchedNotification, setAppForeground } from "./rpc-handlers";
import { startAutoCheck, checkForUpdateWithChannel, getLocalVersion, downloadUpdateForChannel } from "./updater";
import { loadSettings, loadSettingsSync } from "./settings";
import { isQuitConfirmed, markQuitDialogPending } from "./quit-manager";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { getShellRcFiles, getUserShell, resolveShellEnv } from "./shell-env";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
import { startRemoteAccessServer, pushToBrowserClients, generateQrDataUrl, getAccessUrl } from "./remote-access-server";
import { writeSystemClipboard } from "./system-clipboard";
import { stopTunnel } from "./cloudflare-tunnel";
import { installAgentSkills } from "./agent-skills";
import { makeTitle } from "./app-utils";
import { buildApplicationMenu, getMenuContext, MENU_ACTIONS, onMenuContextChange } from "./application-menu";
import { openLogsDirectory } from "./menu-actions";
import { startLoopMonitor } from "./loop-monitor";
import { createAppWindow, broadcastToAllWindows, focusFocusedWindow, getFocusedWindow, getWindowCount, sendToFocusedWindow, setOpenNewWindow } from "./window-manager";
import electrobunConfig from "../../electrobun.config";
import { BUILD_TIME } from "../shared/build-info.generated";
import { existsSync } from "node:fs";

const log = createLogger("main");

// ── Global crash handlers ──
// Catch any unhandled exceptions/rejections BEFORE they kill the process.
// These are the last line of defense — if we get here, something is very wrong.
process.on("uncaughtException", (err) => {
	log.error("UNCAUGHT EXCEPTION — process will crash", {
		error: String(err),
		stack: err?.stack ?? "no stack",
		name: err?.name ?? "unknown",
	});
	console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
	const err = reason instanceof Error ? reason : new Error(String(reason));
	log.error("UNHANDLED REJECTION — promise rejected without .catch()", {
		error: String(err),
		stack: err?.stack ?? "no stack",
		name: err?.name ?? "unknown",
	});
	console.error("UNHANDLED REJECTION:", reason);
});

const APP_VERSION = electrobunConfig.app.version;

let lastBuildTime = BUILD_TIME;

log.info(`=== dev-3.0 starting [${lastBuildTime}] ===`);
log.info("All data at", { dir: DEV3_HOME });
log.info("Log files", { dir: getLogPath() });

// ── CLI binary + agent skills + shell PATH (FIRST — before any async work) ──
// These must run before resolveShellEnv() because existing tmux sessions
// (from a previous app instance) may already have agents trying to use the CLI.
// resolveShellEnv() can take 5-30s on machines with heavy .zshrc — installing
// the CLI after it means agents hit "no such file or directory" on startup.
{
	const { existsSync: fExists, mkdirSync: fMkdir, copyFileSync: fCopy, chmodSync: fChmod,
		readFileSync: fRead, appendFileSync: fAppend } = await import("node:fs");
	const { resolve: fResolve } = await import("node:path");

	// Copy the compiled CLI binaries from the app bundle to ~/.dev3.0/bin/.
	// Two binaries ship together:
	//   dev3         — the CLI (this process is a copy of it in dev/prod).
	//   dev3-server  — the headless server spawned by `dev3 remote`.
	// Both must sit next to each other so locateServerBinary() in
	// src/cli/commands/remote.ts finds dev3-server as a sibling of dev3.
	// Overwritten on every start so the pair always matches the running app version.
	// Production: PATHS.VIEWS_FOLDER (<bundle>/Resources/app/views/) → ../cli/<name>
	// Dev fallback: import.meta.dir (src/bun/) → ../cli/<name>
	const cliBinDir = `${DEV3_HOME}/bin`;
	const installBinary = (name: string, optional: boolean): void => {
		const prodSrc = fResolve(PATHS.VIEWS_FOLDER, "..", "cli", name);
		const devSrc = fResolve(import.meta.dir, "..", "cli", name);
		const bundledSrc = fExists(prodSrc) ? prodSrc : devSrc;
		const dest = `${cliBinDir}/${name}`;
		try {
			fMkdir(cliBinDir, { recursive: true });
			if (fExists(bundledSrc)) {
				fCopy(bundledSrc, dest);
				fChmod(dest, 0o755);
				log.info(`${name} binary installed`, { from: bundledSrc, to: dest });
			} else if (optional) {
				log.info(`${name} binary not in bundle (optional, skip)`, { prodSrc, devSrc });
			} else {
				log.warn(`${name} binary not found in bundle (skip)`, { prodSrc, devSrc });
			}
		} catch (err) {
			log.warn(`${name} setup failed (non-fatal)`, { error: String(err) });
		}
	};

	installBinary("dev3", false);
	// dev3-server is optional: pre-remote-feature releases don't ship it, and a
	// missing sibling is also fine for users who never run `dev3 remote`. The
	// remote handler prints a clear error if it's absent at invocation time.
	installBinary("dev3-server", true);

	// Install dev3 skill into all supported AI agent directories (~/.claude, ~/.codex, etc.).
	// Overwritten on every start to match the running app version (same pattern as CLI binary).
	installAgentSkills();

	// Append ~/.dev3.0/bin to the user's shell rc files (idempotent).
	// This makes `dev3` available in all terminals, not just worktree tmux
	// sessions. For bash this targets both the login profile and .bashrc — see
	// getShellRcFiles for why login bash (macOS / tmux) needs the former.
	const shell = getUserShell();
	process.env.SHELL = shell;
	const home = process.env.HOME || "/tmp";
	const marker = ".dev3.0/bin";
	const rcFiles = getShellRcFiles(shell, home, fExists);
	if (rcFiles.length === 0) {
		log.warn("Skipping shell profile PATH update for unsupported shell", { shell });
	} else {
		for (const rcFile of rcFiles) {
			try {
				const content = fExists(rcFile) ? fRead(rcFile, "utf-8") : "";
				if (!content.includes(marker)) {
					fAppend(rcFile, `\n# dev3.0 CLI\nexport PATH="$HOME/.dev3.0/bin:$PATH"\n`, "utf-8");
					log.info("Shell profile updated with dev3 PATH", { rcFile });
				} else {
					log.info("Shell profile already contains dev3 PATH", { rcFile });
				}
			} catch (err) {
				log.warn("Failed to update shell profile (non-fatal)", { rcFile, error: String(err) });
			}
		}
	}
}

// ── Resolve user's shell environment (PATH + LANG + key gh config vars) ──
// macOS .app bundles inherit a minimal env: PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// no LANG. Without LANG, tmux replaces non-ASCII chars (Cyrillic, etc.) with
// underscores. Resolve both from the user's login shell BEFORE starting the PTY.
const originalPath = process.env.PATH;
const originalLang = process.env.LANG;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalGhConfigDir = process.env.GH_CONFIG_DIR;
const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
const shellEnv = await resolveShellEnv();
if (shellEnv.path) {
	process.env.PATH = shellEnv.path;
	log.info("Shell PATH resolved", {
		original: originalPath,
		resolved: shellEnv.path,
	});
} else {
	log.warn("Could not resolve shell PATH, using original", { path: originalPath });
}

// Ensure well-known user binary directories are in PATH.
// Some shells/configs don't add these, but tools like pip, pipx, and
// Claude CLI install binaries there. Append missing dirs that exist on disk.
{
	const home = process.env.HOME;
	if (home) {
		const userBinDirs = [
			`${home}/.local/bin`,
			`${home}/bin`,
		];
		for (const dir of userBinDirs) {
			if (!process.env.PATH?.includes(dir) && existsSync(dir)) {
				process.env.PATH = `${process.env.PATH}:${dir}`;
				log.info("Appended user bin dir to PATH", { dir });
			}
		}
	}
}

if (shellEnv.lang) {
	process.env.LANG = shellEnv.lang;
	log.info("Shell LANG resolved", {
		original: originalLang,
		resolved: shellEnv.lang,
	});
} else if (!process.env.LANG) {
	// Fallback: ensure UTF-8 even if the shell doesn't export LANG
	process.env.LANG = "en_US.UTF-8";
	log.info("LANG not found in shell, using fallback", { lang: "en_US.UTF-8" });
}

if (shellEnv.xdgConfigHome) {
	process.env.XDG_CONFIG_HOME = shellEnv.xdgConfigHome;
	log.info("Shell XDG_CONFIG_HOME resolved", {
		original: originalXdgConfigHome,
		resolved: shellEnv.xdgConfigHome,
	});
}

if (shellEnv.ghConfigDir) {
	process.env.GH_CONFIG_DIR = shellEnv.ghConfigDir;
	log.info("Shell GH_CONFIG_DIR resolved", {
		original: originalGhConfigDir,
		resolved: shellEnv.ghConfigDir,
	});
}

if (shellEnv.sshAuthSock) {
	process.env.SSH_AUTH_SOCK = shellEnv.sshAuthSock;
	log.info("Shell SSH_AUTH_SOCK resolved", {
		original: originalSshAuthSock,
		resolved: shellEnv.sshAuthSock,
	});
}

// Inherit the user's full exported shell environment (credentials for env-based
// MCP servers, SDK keys, etc.) so agents launched in non-interactive tmux
// sessions see exactly what a real terminal would. Gated by a global setting
// (default on); the typed vars above and runtime junk are already filtered out
// in resolveShellEnv. The patched process.env flows to the tmux server and
// every agent/MCP child via the normal inheritance chain.
if (shellEnv.fullEnv) {
	const importShellEnv = (await loadSettings()).importShellEnv !== false;
	if (importShellEnv) {
		let injected = 0;
		for (const [key, value] of Object.entries(shellEnv.fullEnv)) {
			process.env[key] = value;
			injected++;
		}
		log.info("Inherited user shell environment", { injected });
	} else {
		log.info("importShellEnv disabled — skipping full shell env inheritance");
	}
}

// ── CLI socket server ──
// Start Unix domain socket server for CLI tool communication.
const cliSocketPath = startSocketServer();
log.info("CLI socket server ready", { path: cliSocketPath });

// Daily projects.json safety snapshot (projects-YYYY-MM-DD.json.bak, 7 days kept).
// Saves also trigger it, but projects.json can go untouched for weeks — the
// startup hook guarantees at least one fresh backup per day the app is used.
{
	const { backupProjectsDaily } = await import("./data");
	backupProjectsDaily().catch((err) => {
		log.warn("Startup projects backup failed (non-fatal)", { err });
	});
}

// Side-effect: starts the PTY WebSocket server (dynamic import so PATH is patched first)
const { setOnPtyDied, setOnBell, setOnIdle, setOnPaneExited, setOnOsc52Copy, getActiveSessionIds, getPtyPort } = await import("./pty-server");
const { startPortScanPoller, stopPortScanPoller } = await import("./port-scanner");
const { startResourceMonitor, stopResourceMonitor } = await import("./resource-monitor");

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// --- Main Window ---

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	log.info("App channel", { channel });
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			log.info(`HMR enabled: Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			log.warn("Vite dev server not running, falling back to bundled assets");
		}
	}
	return "views://mainview/index.html";
}

const url = await getMainViewUrl();
log.info("Loading URL", { url });

// --- Application Menu ---

ApplicationMenu.setApplicationMenu(buildApplicationMenu(getMenuContext()));

// Rebuild the menu whenever the renderer pushes a new context (route change).
// Items that require a task / project / terminal toggle their enabled state.
onMenuContextChange((ctx) => {
	log.debug("Menu context changed, rebuilding native menu", { hasTask: ctx.hasTask, hasProject: ctx.hasProject, hasTerminal: ctx.hasTerminal });
	ApplicationMenu.setApplicationMenu(buildApplicationMenu(ctx));
});

// --- Main Window ---

async function openMainWindow() {
	return createAppWindow({
		title: makeTitle(APP_VERSION, lastBuildTime),
		url,
		handlers: handlers as unknown as Record<string, (...args: unknown[]) => unknown>,
		onDomReady: async (win) => {
			const channel = await Updater.localInfo.channel();
			if (channel === "dev") {
				win.webview.openDevTools();
			}
			log.info(`DOM ready [${lastBuildTime}]`);
		},
		onExternalLink: (externalUrl) => {
			log.info("Opening external URL", { url: externalUrl });
			Utils.openExternal(externalUrl);
		},
		onFocus: () => {
			// A window gaining key focus means the app is foreground. The renderer
			// also reports this via setWindowForeground, but the native focus event
			// is the authoritative source and never races renderer mount timing.
			setAppForeground(true);
			tryNavigateFromRecentNotification("window-focus");
		},
	});
}

// Let RPC handlers (renderer Cmd+Shift+N) open a new window without importing
// this module.
setOpenNewWindow(() => {
	void openMainWindow();
});

await openMainWindow();
log.info("Main window created");

// Wire push messages: every open renderer window + any connected browser clients.
setPushMessage((name, payload) => {
	log.debug("Push to renderer", { name });
	broadcastToAllWindows(name, payload);
	pushToBrowserClients(name, payload);
});

// `exposedPortsChanged` rides its own hook because port-tunnels lives below
// rpc-handlers — same broadcast target as above.
import("./port-tunnels").then(({ setPortTunnelsPushHook }) => {
	setPortTunnelsPushHook((name, payload) => {
		broadcastToAllWindows(name, payload);
		pushToBrowserClients(name, payload);
	});
}).catch((err) => log.warn("port-tunnels push hook setup failed", { error: String(err) }));

// Start remote access server (serves UI + RPC + PTY proxy on LAN)
await startRemoteAccessServer({
	rpcHandler: async (method: string, params: any) => {
		const handler = (handlers as any)[method];
		if (!handler) throw new Error(`Unknown RPC method: ${method}`);
		return await handler(params);
	},
	getPtyPort,
	onQrTokenConsumed: () => {
		getPushMessage()?.("qrTokenConsumed", {});
	},
});

// Diagnostic: log whenever the Bun event loop is blocked for >500ms.
// Silent during normal operation — only fires on stalls (e.g. accidental
// sync I/O, GC pauses, runaway regex).
startLoopMonitor();

// Start background merge detection poller
startMergeDetectionPoller();

// Start background PR detection poller (auto-moves review-by-user → review-by-colleague)
startPRDetectionPoller();

// Start background port scan poller (detects listening TCP ports per task)
startPortScanPoller(
	(name, payload) => {
		try {
			broadcastToAllWindows(name, payload);
		} catch (err) {
			log.error("Failed to push port update", { error: String(err) });
		}
	},
	getActiveSessionIds,
);

// Start background resource usage monitor (discovers tmux sessions directly, not via pty-server)
startResourceMonitor((name, payload) => {
	try {
		broadcastToAllWindows(name, payload);
	} catch (err) {
		log.error("Failed to push resource usage update", { error: String(err) });
	}
});

// Wire PTY death notifications
setOnPtyDied((sessionKey) => {
	try {
		if (sessionKey === "home") {
			log.info("Home terminal died, notifying renderer");
			broadcastToAllWindows("homePtyDied", {});
		} else if (sessionKey.startsWith("project-")) {
			const projectId = sessionKey.slice(8);
			log.info("Project terminal died, notifying renderer", { projectId: projectId.slice(0, 8) });
			broadcastToAllWindows("projectPtyDied", { projectId });
		} else {
			log.info("PTY died, notifying renderer", { taskId: sessionKey.slice(0, 8) });
			broadcastToAllWindows("ptyDied", { taskId: sessionKey });
		}
	} catch (err) {
		log.error("Failed to notify renderer about PTY death", {
			sessionKey: sessionKey.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}
});

// Wire terminal bell notifications
setOnBell((sessionKey) => {
	try {
		// Project and home terminals are plain shells — skip bell/auto-status logic
		if (sessionKey === "home") return;
		if (sessionKey.startsWith("project-")) return;

		log.debug("Terminal bell, notifying renderer", { taskId: sessionKey.slice(0, 8) });
		broadcastToAllWindows("terminalBell", { taskId: sessionKey });
		// Auto-move task from "in-progress" to "user-questions" on bell
		handleBellAutoStatus(sessionKey).catch((err) => {
			log.error("handleBellAutoStatus unhandled error", { error: String(err) });
		});
	} catch (err) {
		log.error("Failed to handle terminal bell", {
			taskId: sessionKey.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}
});

// Wire terminal idle notifications (red badge only, no status transition)
// Only fires for tasks that are currently "in-progress" — idle terminals
// in other statuses (review, todo, etc.) are expected and not noteworthy.
setOnIdle((sessionKey) => {
	// Project and home terminals have no task status — skip idle notifications
	if (sessionKey === "home") return;
	if (sessionKey.startsWith("project-")) return;

	isTaskInProgress(sessionKey).then((inProgress) => {
		if (!inProgress) return;
		try {
			log.debug("Terminal idle, notifying renderer", { taskId: sessionKey.slice(0, 8) });
			broadcastToAllWindows("terminalBell", { taskId: sessionKey });
		} catch (err) {
			log.error("Failed to handle terminal idle", {
				taskId: sessionKey.slice(0, 8),
				error: String(err),
			});
		}
	}).catch((err) => {
		log.error("isTaskInProgress failed in idle handler", { error: String(err) });
	});
});

setOnOsc52Copy((payload) => {
	// Write directly to the host clipboard. The renderer cannot do this
	// reliably — navigator.clipboard.writeText() in Electrobun WKWebView
	// requires a user gesture, and an async WS message is not one.
	const tool = writeSystemClipboard(payload.text);
	if (tool) {
		log.info("OSC 52 written to host clipboard", {
			taskId: payload.taskId.slice(0, 8),
			len: payload.len,
			tool,
		});
	}
	// Still forward to renderer (diagnostics) and remote browser clients
	// (where the user's clipboard is the browser, not the host).
	try {
		broadcastToAllWindows("osc52Clipboard", payload);
		pushToBrowserClients("osc52Clipboard", payload);
	} catch (err) {
		log.error("Failed to forward OSC 52 clipboard payload", {
			taskId: payload.taskId.slice(0, 8),
			error: String(err),
		});
	}
});

// Wire pane-exited notifications — remove dead pane entries from sessionState
setOnPaneExited((taskId, paneId) => {
	handlePaneExited(taskId, paneId).catch((err) => {
		log.error("handlePaneExited unhandled error", { error: String(err) });
	});
});

function runGlobalQuitCleanup(): void {
	log.info("App is quitting, running global cleanup");
	try { stopPortScanPoller(); } catch (err) { log.warn("stopPortScanPoller failed", { error: String(err) }); }
	try { stopResourceMonitor(); } catch (err) { log.warn("stopResourceMonitor failed", { error: String(err) }); }
	try { stopSocketServer(); } catch (err) { log.warn("stopSocketServer failed", { error: String(err) }); }
	// Tear down every per-task cloudflared process spawned by the GUI's
	// `Expose port` button or by `--expose-ports`. Leaving them running
	// would orphan tunnels (and trycloudflare quotas) on app exit.
	import("./port-tunnels").then(({ cleanupAllTunnels }) => cleanupAllTunnels()).catch(() => { /* shutdown — best-effort */ });
	try { stopTunnel(); } catch (err) { log.warn("stopTunnel failed", { error: String(err) }); }
}

// Single quit gate for EVERY quit trigger — Cmd+Q, menu Quit, closing the last
// window (red X / Cmd+W), updater restart, signals. Fires once per attempt.
//
// Unless the user already confirmed (via the React dialog → `quitApp`) or opted
// out (`skipQuitDialog`), we cancel the quit and ask the renderer to show the
// confirmation dialog. The actual teardown + exit happens on the second pass,
// once `quitApp` has set the confirmed flag.
//
// With `exitOnLastWindowClosed: false`, closing the last window keeps the app
// alive in the dock — it does NOT trigger a quit. So a quit here is always
// deliberate (Cmd+Q, menu Quit, dock Quit). If a window is open we focus it
// (a dock right-click → Quit does not activate the app, so the dialog would
// otherwise sit hidden behind other apps) and push the dialog to it; if none
// is (the app was sitting window-less in the dock) we reopen one and let it
// PULL the pending flag on mount — a push would race the not-yet-mounted
// renderer and get lost.
Electrobun.events.on("before-quit", (e: { response?: { allow: boolean } }) => {
	if (isQuitConfirmed()) {
		runGlobalQuitCleanup();
		return;
	}
	let skip = false;
	try {
		skip = loadSettingsSync().skipQuitDialog === true;
	} catch (err) {
		log.warn("Failed to read skipQuitDialog setting", { error: String(err) });
	}
	if (skip) {
		runGlobalQuitCleanup();
		return;
	}

	// Cancel this quit and ask for confirmation.
	e.response = { allow: false };

	if (getFocusedWindow()) {
		// Bring the window to the front first. A dock right-click → Quit does NOT
		// activate the app on macOS, so without this the dialog would sit behind
		// other apps and the app would look frozen.
		log.info("Quit intercepted — focusing window and asking it to confirm");
		focusFocusedWindow();
		sendToFocusedWindow("showQuitDialog");
	} else {
		// App is window-less in the dock. Reopen a window to host the dialog;
		// it pulls the pending flag on mount (see quit-manager).
		log.info("Quit intercepted with no window — reopening one to confirm");
		markQuitDialogPending();
		void openMainWindow();
	}
});

// Click-to-open for watched-task notifications.
// Electrobun's Utils.showNotification has no click callback, so we treat any "app became
// foreground" signal that arrives shortly after a notification fired as a click-through.
//
// We listen on multiple events because none of them fire reliably in every scenario:
//   - window focus  — fires on windowDidBecomeKey: (does NOT re-fire if the window was
//                      already key, e.g. another app was just on top). Wired per-window
//                      via the createAppWindow onFocus hook.
//   - `app.reopen`  — fires on applicationShouldHandleReopen: (dock click, some
//                      notification-activation paths on macOS).
//
// On the first signal we consume the recent-notification slot and tell the focused window
// to navigate. Subsequent signals find the slot empty and no-op.
function tryNavigateFromRecentNotification(source: string): void {
	const recent = consumeRecentWatchedNotification();
	log.debug(`[notif] activation signal received (${source})`, {
		hadRecent: !!recent,
		taskId: recent?.taskId?.slice(0, 8) ?? null,
	});
	if (!recent) return;
	sendToFocusedWindow("openTaskFromNotification", recent);
}

Electrobun.events.on("reopen", () => {
	// With `exitOnLastWindowClosed: false` the app can sit window-less in the
	// dock. A dock-icon click (reopen) should bring a window back, like any mac
	// app. If a window already exists, treat it as a notification-activation.
	if (getWindowCount() === 0) {
		log.info("Reopen with no window — opening a fresh window");
		void openMainWindow();
		return;
	}
	tryNavigateFromRecentNotification("app-reopen");
});

// Helper to push update progress to the renderer
const sendUpdateProgress = (status: string, progress?: number) => {
	broadcastToAllWindows("updateDownloadProgress", { status, progress });
};

// --- Menu Event Handlers ---

Electrobun.events.on("application-menu-clicked", async (e) => {
	// Most menu actions target the currently focused window; a few (update
	// progress, broadcast notifications) reach all windows via broadcast.
	const focused = getFocusedWindow();

	if (e.data.action === MENU_ACTIONS.newWindow) {
		log.info("Menu: open new window");
		await openMainWindow();
		return;
	}

	if (e.data.action === MENU_ACTIONS.hardRefresh) {
		log.info("Hard refresh — navigating to home page");
		focused?.webview.loadURL(url);
	} else if (e.data.action === MENU_ACTIONS.about) {
		sendToFocusedWindow("showAbout", { version: APP_VERSION });
	} else if (e.data.action === MENU_ACTIONS.openSettings) {
		sendToFocusedWindow("navigateToSettings");
	} else if (e.data.action === MENU_ACTIONS.openNewTask) {
		sendToFocusedWindow("openCreateTaskModal");
	} else if (e.data.action === MENU_ACTIONS.openAddProject) {
		sendToFocusedWindow("openAddProjectModal");
	} else if (e.data.action === MENU_ACTIONS.gaugeDemo) {
		sendToFocusedWindow("navigateToGaugeDemo");
	} else if (e.data.action === MENU_ACTIONS.viewportLab) {
		sendToFocusedWindow("navigateToViewportLab");
	} else if (e.data.action === MENU_ACTIONS.checkForUpdates) {
		// Mirror the silent auto-update flow: check, then download in the background.
		// A ready update surfaces as the existing header "Update ready" plaque
		// (`updateAvailable`); "up to date" / errors surface as in-app toasts
		// (`updateCheckOutcome`). No native message boxes — works in remote mode too.
		try {
			const settings = await loadSettings();
			sendUpdateProgress("checking");
			const result = await checkForUpdateWithChannel(settings.updateChannel);

			if (result.error) {
				sendUpdateProgress("idle");
				sendToFocusedWindow("updateCheckOutcome", { status: "error", detail: result.error });
			} else if (result.updateAvailable) {
				sendUpdateProgress("downloading", 0);
				const dlResult = await downloadUpdateForChannel(settings.updateChannel, sendUpdateProgress);
				if (dlResult.ok) {
					broadcastToAllWindows("updateAvailable", { version: result.version });
				} else {
					sendUpdateProgress("error");
					sendToFocusedWindow("updateCheckOutcome", { status: "error", detail: dlResult.error || "Download failed" });
				}
			} else {
				sendUpdateProgress("idle");
				sendToFocusedWindow("updateCheckOutcome", { status: "none", version: (await getLocalVersion()).version });
			}
		} catch (err) {
			sendUpdateProgress("idle");
			log.error("Menu check-for-updates failed", { error: String(err) });
			sendToFocusedWindow("updateCheckOutcome", { status: "error", detail: String(err) });
		}
	} else if (e.data.action === "terminal-soft-reset") {
		sendToFocusedWindow("terminalSoftReset");
	} else if (e.data.action === "terminal-hard-reset") {
		sendToFocusedWindow("terminalHardReset");
	} else if (e.data.action === "toggle-devtools") {
		focused?.webview.openDevTools();
	} else if (e.data.action === "open-logs-directory") {
		openLogsDirectory();
	} else if (e.data.action === "zoom-in") {
		sendToFocusedWindow("zoomIn");
	} else if (e.data.action === "zoom-out") {
		sendToFocusedWindow("zoomOut");
	} else if (e.data.action === "zoom-reset") {
		sendToFocusedWindow("zoomReset");
	} else if (e.data.action === "show-remote-qr") {
		try {
			const qrDataUrl = await generateQrDataUrl();
			const accessUrl = await getAccessUrl();
			const { isCloudflaredAvailable, getTunnelState } = await import("./cloudflare-tunnel");
			sendToFocusedWindow("showRemoteAccessQR", { qrDataUrl, accessUrl, tunnelState: getTunnelState(), cloudflaredInstalled: isCloudflaredAvailable() });
		} catch (err) {
			log.error("Failed to generate QR code", { error: String(err) });
		}
	} else if (e.data.action === MENU_ACTIONS.helpGithub) {
		Utils.openExternal("https://github.com/h0x91b/dev-3.0");
	} else if (e.data.action === MENU_ACTIONS.helpReportBug) {
		Utils.openExternal("https://github.com/h0x91b/dev-3.0/issues/new");
	} else if (e.data.action === MENU_ACTIONS.helpDocumentation) {
		Utils.openExternal("https://h0x91b.github.io/dev-3.0/");
	} else {
		// Everything else (task / project / view / terminal actions that the
		// renderer is responsible for) goes through the universal `menuAction`
		// push channel. The renderer's `menuRouter` (App.tsx listener) decides
		// what to do based on its current state.
		log.debug("Routing menu action to renderer", { action: e.data.action });
		sendToFocusedWindow("menuAction", { action: e.data.action });
	}
});

// --- Auto-Update Check ---

startAutoCheck(
	() => loadSettings().then((s) => s.updateChannel),
	async (version) => {
		log.info("Auto-check found update, downloading silently...", { version });
		const settings = await loadSettings();
		sendUpdateProgress("downloading", 0);
		const dlResult = await downloadUpdateForChannel(settings.updateChannel, sendUpdateProgress);
		if (dlResult.ok) {
			log.info("Auto-download complete, notifying renderer", { version });
			broadcastToAllWindows("updateAvailable", { version });
		} else {
			log.error("Auto-download failed", { error: dlResult.error });
			sendUpdateProgress("error");
		}
	},
	sendUpdateProgress,
);

log.info("=== dev-3.0 ready ===");
