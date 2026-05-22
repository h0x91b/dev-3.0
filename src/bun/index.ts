import Electrobun, {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
	Utils,
} from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { handlers, setPushMessage, getPushMessage, handleBellAutoStatus, isTaskInProgress, startMergeDetectionPoller, startPRDetectionPoller, handlePaneExited, consumeRecentWatchedNotification } from "./rpc-handlers";
import { startAutoCheck, checkForUpdateWithChannel, getLocalVersion, downloadUpdateForChannel, applyUpdate } from "./updater";
import { loadSettings } from "./settings";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { getShellRcFile, getUserShell, resolveShellEnv } from "./shell-env";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
import { startRemoteAccessServer, pushToBrowserClients, generateQrDataUrl, getAccessUrl } from "./remote-access-server";
import { writeSystemClipboard } from "./system-clipboard";
import { stopTunnel } from "./cloudflare-tunnel";
import { installAgentSkills } from "./agent-skills";
import { makeTitle } from "./app-utils";
import { buildApplicationMenu, getMenuContext, MENU_ACTIONS, onMenuContextChange } from "./application-menu";
import { openLogsDirectory } from "./menu-actions";
import { startLoopMonitor } from "./loop-monitor";
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

	// Append ~/.dev3.0/bin to the user's shell RC file (idempotent).
	// This makes `dev3` available in all terminals, not just worktree tmux sessions.
	const shell = getUserShell();
	process.env.SHELL = shell;
	const home = process.env.HOME || "/tmp";
	const marker = ".dev3.0/bin";
	const rcFile = getShellRcFile(shell, home);
	if (!rcFile) {
		log.warn("Skipping shell profile PATH update for unsupported shell", { shell });
	} else {
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

// ── CLI socket server ──
// Start Unix domain socket server for CLI tool communication.
const cliSocketPath = startSocketServer();
log.info("CLI socket server ready", { path: cliSocketPath });

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

// --- RPC ---

const rpc = BrowserView.defineRPC<AppRPCSchema>({
	maxRequestTime: 120_000,
	handlers: {
		requests: handlers as any,
		messages: {},
	},
});

log.info("RPC handlers registered");

// --- Application Menu ---

ApplicationMenu.setApplicationMenu(buildApplicationMenu(getMenuContext()));

// Rebuild the menu whenever the renderer pushes a new context (route change).
// Items that require a task / project / terminal toggle their enabled state.
onMenuContextChange((ctx) => {
	log.debug("Menu context changed, rebuilding native menu", { hasTask: ctx.hasTask, hasProject: ctx.hasProject, hasTerminal: ctx.hasTerminal });
	ApplicationMenu.setApplicationMenu(buildApplicationMenu(ctx));
});

// --- Main Window ---

// Size the window to ~95% of the primary display's work area, centered
const primaryDisplay = Screen.getPrimaryDisplay();
const workArea = primaryDisplay.workArea;
const WINDOW_RATIO = 0.95;
const windowWidth = Math.round(workArea.width * WINDOW_RATIO);
const windowHeight = Math.round(workArea.height * WINDOW_RATIO);
const windowX = workArea.x + Math.round((workArea.width - windowWidth) / 2);
const windowY = workArea.y + Math.round((workArea.height - windowHeight) / 2);

const mainWindow = new BrowserWindow({
	title: makeTitle(APP_VERSION, lastBuildTime),
	url,
	rpc,
	frame: {
		width: windowWidth,
		height: windowHeight,
		x: windowX,
		y: windowY,
	},
});

log.info("Main window created");

// Wire push messages to renderer (Electrobun + browser clients)
setPushMessage((name, payload) => {
	log.debug("Push to renderer", { name });
	if (name === "qrTokenConsumed") {
		mainWindow.webview.rpc?.send("qrTokenConsumed", {});
	} else {
		(mainWindow.webview.rpc as any).send[name]?.(payload);
	}
	pushToBrowserClients(name, payload);
});

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
			(mainWindow.webview.rpc as any).send[name]?.(payload);
		} catch (err) {
			log.error("Failed to push port update", { error: String(err) });
		}
	},
	getActiveSessionIds,
);

// Start background resource usage monitor (discovers tmux sessions directly, not via pty-server)
startResourceMonitor((name, payload) => {
	try {
		(mainWindow.webview.rpc as any).send[name]?.(payload);
	} catch (err) {
		log.error("Failed to push resource usage update", { error: String(err) });
	}
});

// Wire PTY death notifications
setOnPtyDied((sessionKey) => {
	try {
		if (sessionKey === "home") {
			log.info("Home terminal died, notifying renderer");
			(mainWindow.webview.rpc as any).send.homePtyDied?.({});
		} else if (sessionKey.startsWith("project-")) {
			const projectId = sessionKey.slice(8);
			log.info("Project terminal died, notifying renderer", { projectId: projectId.slice(0, 8) });
			(mainWindow.webview.rpc as any).send.projectPtyDied?.({ projectId });
		} else {
			log.info("PTY died, notifying renderer", { taskId: sessionKey.slice(0, 8) });
			(mainWindow.webview.rpc as any).send.ptyDied?.({ taskId: sessionKey });
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
		(mainWindow.webview.rpc as any).send.terminalBell?.({ taskId: sessionKey });
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
			(mainWindow.webview.rpc as any).send.terminalBell?.({ taskId: sessionKey });
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
		(mainWindow.webview.rpc as any).send.osc52Clipboard?.(payload);
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

mainWindow.on("close", () => {
	log.info("Main window closing, cleaning up");
	stopPortScanPoller();
	stopResourceMonitor();
	stopSocketServer();
	stopTunnel();
	Utils.quit();
});

// Click-to-open for watched-task notifications.
// Electrobun's Utils.showNotification has no click callback, so we treat any "app became
// foreground" signal that arrives shortly after a notification fired as a click-through.
//
// We listen on multiple events because none of them fire reliably in every scenario:
//   - `window.focus`            — fires on windowDidBecomeKey: (does NOT re-fire if the
//                                  window was already key, e.g. another app was just on top)
//   - `app.reopen` (global)     — fires on applicationShouldHandleReopen: (dock click,
//                                  some notification-activation paths on macOS)
//   - `webview.dom-focus` proxy — fires when the WKWebView regains focus inside the window
//
// On the first signal we consume the recent-notification slot and tell the renderer to
// navigate. Subsequent signals find the slot empty and no-op.
function tryNavigateFromRecentNotification(source: string): void {
	const recent = consumeRecentWatchedNotification();
	log.debug(`[notif] activation signal received (${source})`, {
		hadRecent: !!recent,
		taskId: recent?.taskId?.slice(0, 8) ?? null,
	});
	if (!recent) return;
	try {
		(mainWindow.webview.rpc as any).send.openTaskFromNotification?.(recent);
	} catch (err) {
		log.error("Failed to push openTaskFromNotification", { error: String(err) });
	}
}

mainWindow.on("focus", () => tryNavigateFromRecentNotification("window-focus"));
Electrobun.events.on("reopen", () => tryNavigateFromRecentNotification("app-reopen"));

// Open DevTools automatically on dev channel
mainWindow.webview.on("dom-ready", async () => {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		mainWindow.webview.openDevTools();
	}
	log.info(`DOM ready [${lastBuildTime}]`);
});

// Open external links in the default browser.
// ghostty-web's built-in link providers call window.open() on Cmd+Click,
// which triggers this event in the WKWebView. Redirect to system browser.
(mainWindow.webview as any).on("new-window-open", (e: any) => {
	const url = e.data?.detail?.url;
	if (typeof url === "string" && /^https?:\/\//.test(url)) {
		log.info("Opening external URL", { url });
		Utils.openExternal(url);
	} else {
		log.warn("Blocked new-window-open with unexpected URL", { data: e.data });
	}
});

// Helper to push update progress to the renderer
const sendUpdateProgress = (status: string, progress?: number) => {
	(mainWindow.webview.rpc as any).send.updateDownloadProgress?.({ status, progress });
};

// --- Menu Event Handlers ---

Electrobun.events.on("application-menu-clicked", async (e) => {
	if (e.data.action === MENU_ACTIONS.hardRefresh) {
		log.info("Hard refresh — navigating to home page");
		mainWindow.webview.loadURL(url);
	} else if (e.data.action === MENU_ACTIONS.about) {
		Utils.showMessageBox({
			type: "info",
			title: "About",
			message: `dev-3.0 v${APP_VERSION}`,
			detail: "Terminal-centric project manager\nBuilt with Electrobun, React, and Bun.",
			buttons: ["OK"],
		});
	} else if (e.data.action === MENU_ACTIONS.openSettings) {
		mainWindow.webview.rpc?.send("navigateToSettings", {});
	} else if (e.data.action === MENU_ACTIONS.openNewTask) {
		mainWindow.webview.rpc?.send("openCreateTaskModal", {});
	} else if (e.data.action === MENU_ACTIONS.openAddProject) {
		mainWindow.webview.rpc?.send("openAddProjectModal", {});
	} else if (e.data.action === MENU_ACTIONS.gaugeDemo) {
		mainWindow.webview.rpc?.send("navigateToGaugeDemo", {});
	} else if (e.data.action === MENU_ACTIONS.viewportLab) {
		mainWindow.webview.rpc?.send("navigateToViewportLab", {});
	} else if (e.data.action === MENU_ACTIONS.checkForUpdates) {
		try {
			const settings = await loadSettings();
			sendUpdateProgress("checking");
			const result = await checkForUpdateWithChannel(settings.updateChannel);
			sendUpdateProgress("idle");

			if (result.error) {
				Utils.showMessageBox({
					type: "warning",
					title: "Update Check Failed",
					message: "Could not check for updates",
					detail: result.error,
					buttons: ["OK"],
				});
			} else if (result.updateAvailable) {
				const { response } = await Utils.showMessageBox({
					type: "info",
					title: "Update Available",
					message: `Version ${result.version} is available`,
					detail: "Would you like to download the update?",
					buttons: ["Download", "Later"],
					defaultId: 0,
					cancelId: 1,
				});
				if (response === 0) {
					sendUpdateProgress("downloading", 0);
					const dlResult = await downloadUpdateForChannel(settings.updateChannel, sendUpdateProgress);
					if (dlResult.ok) {
						const { response: restartResponse } = await Utils.showMessageBox({
							type: "info",
							title: "Update Downloaded",
							message: "Update is ready to install",
							detail: "The app will restart to apply the update.",
							buttons: ["Restart Now", "Later"],
							defaultId: 0,
							cancelId: 1,
						});
						if (restartResponse === 0) {
							await applyUpdate();
						}
					} else {
						Utils.showMessageBox({
							type: "warning",
							title: "Download Failed",
							message: "Could not download the update",
							detail: dlResult.error || "Unknown error",
							buttons: ["OK"],
						});
					}
				}
			} else {
				Utils.showMessageBox({
					type: "info",
					title: "No Updates",
					message: "You're up to date!",
					detail: `Current version: ${(await getLocalVersion()).version}`,
					buttons: ["OK"],
				});
			}
		} catch (err) {
			sendUpdateProgress("idle");
			log.error("Menu check-for-updates failed", { error: String(err) });
			Utils.showMessageBox({
				type: "warning",
				title: "Update Check Failed",
				message: "Could not check for updates",
				detail: String(err),
				buttons: ["OK"],
			});
		}
	} else if (e.data.action === "terminal-soft-reset") {
		mainWindow.webview.rpc?.send("terminalSoftReset", {});
	} else if (e.data.action === "terminal-hard-reset") {
		mainWindow.webview.rpc?.send("terminalHardReset", {});
	} else if (e.data.action === "toggle-devtools") {
		mainWindow.webview.openDevTools();
	} else if (e.data.action === "open-logs-directory") {
		openLogsDirectory();
	} else if (e.data.action === "zoom-in") {
		mainWindow.webview.rpc?.send("zoomIn", {});
	} else if (e.data.action === "zoom-out") {
		mainWindow.webview.rpc?.send("zoomOut", {});
	} else if (e.data.action === "zoom-reset") {
		mainWindow.webview.rpc?.send("zoomReset", {});
	} else if (e.data.action === "show-remote-qr") {
		try {
			const qrDataUrl = await generateQrDataUrl();
			const accessUrl = await getAccessUrl();
			const { isCloudflaredAvailable, getTunnelState } = await import("./cloudflare-tunnel");
			mainWindow.webview.rpc?.send("showRemoteAccessQR", { qrDataUrl, accessUrl, tunnelState: getTunnelState(), cloudflaredInstalled: isCloudflaredAvailable() });
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
		mainWindow.webview.rpc?.send("menuAction", { action: e.data.action });
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
			(mainWindow.webview.rpc as any).send.updateAvailable?.({ version });
		} else {
			log.error("Auto-download failed", { error: dlResult.error });
			sendUpdateProgress("error");
		}
	},
	sendUpdateProgress,
);

log.info("=== dev-3.0 ready ===");
