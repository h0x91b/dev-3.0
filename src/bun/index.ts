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
import { handlers, setPushMessage, handleBellAutoStatus, isTaskInProgress, startMergeDetectionPoller, startPRDetectionPoller } from "./rpc-handlers";
import { startAutoCheck, checkForUpdateWithChannel, getLocalVersion, downloadUpdateForChannel, applyUpdate } from "./updater";
import { loadSettings } from "./settings";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { resolveShellEnv } from "./shell-env";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
import { installAgentSkills } from "./agent-skills";
import { makeTitle } from "./app-utils";
import electrobunConfig from "../../electrobun.config";
import { BUILD_TIME } from "../shared/build-info.generated";

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

	// Copy the compiled CLI binary from app bundle to ~/.dev3.0/bin/dev3.
	// Overwritten on every start to ensure it matches the running app version.
	// Production: PATHS.VIEWS_FOLDER (<bundle>/Resources/app/views/) → ../cli/dev3
	// Dev fallback: import.meta.dir (src/bun/) → ../cli/dev3
	const cliBinDir = `${DEV3_HOME}/bin`;
	const cliDest = `${cliBinDir}/dev3`;
	const prodCli = fResolve(PATHS.VIEWS_FOLDER, "..", "cli", "dev3");
	const devCli = fResolve(import.meta.dir, "..", "cli", "dev3");
	const bundledCli = fExists(prodCli) ? prodCli : devCli;

	try {
		fMkdir(cliBinDir, { recursive: true });
		if (fExists(bundledCli)) {
			fCopy(bundledCli, cliDest);
			fChmod(cliDest, 0o755);
			log.info("CLI binary installed", { from: bundledCli, to: cliDest });
		} else {
			log.warn("CLI binary not found in bundle (skip)", { prodCli, devCli });
		}
	} catch (err) {
		log.warn("CLI setup failed (non-fatal)", { error: String(err) });
	}

	// Install dev3 skill into all supported AI agent directories (~/.claude, ~/.codex, etc.).
	// Overwritten on every start to match the running app version (same pattern as CLI binary).
	installAgentSkills();

	// Append ~/.dev3.0/bin to the user's shell RC file (idempotent).
	// This makes `dev3` available in all terminals, not just worktree tmux sessions.
	const shell = process.env.SHELL || "/bin/zsh";
	const home = process.env.HOME || "/tmp";
	const rcFile = shell.endsWith("bash") ? `${home}/.bashrc` : `${home}/.zshrc`;
	const marker = ".dev3.0/bin";
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

// ── Resolve user's shell environment (PATH + LANG) ──
// macOS .app bundles inherit a minimal env: PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// no LANG. Without LANG, tmux replaces non-ASCII chars (Cyrillic, etc.) with
// underscores. Resolve both from the user's login shell BEFORE starting the PTY.
const originalPath = process.env.PATH;
const originalLang = process.env.LANG;
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

// ── CLI socket server ──
// Start Unix domain socket server for CLI tool communication.
const cliSocketPath = startSocketServer();
log.info("CLI socket server ready", { path: cliSocketPath });

// Side-effect: starts the PTY WebSocket server (dynamic import so PATH is patched first)
const { setOnPtyDied, setOnBell, setOnIdle, getActiveSessionIds } = await import("./pty-server");
const { startPortScanPoller } = await import("./port-scanner");

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
		requests: handlers,
		messages: {},
	},
});

log.info("RPC handlers registered");

// --- Application Menu ---

ApplicationMenu.setApplicationMenu([
	{
		label: "dev-3.0",
		submenu: [
			{ label: "About dev-3.0", action: "about" },
			{ label: "Check for Updates...", action: "check-for-updates" },
			{ type: "separator" },
			{ label: "Settings...", action: "open-settings", accelerator: "," },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
		],
	},
	{
		label: "View",
		submenu: [
			{ label: "Hard Refresh", action: "hard-refresh", accelerator: "r" },
			{ label: "Toggle Developer Tools", action: "toggle-devtools" },
			{ type: "separator" },
			{ label: "Soft Reset Terminal", action: "terminal-soft-reset" },
			{ label: "Hard Reset Terminal", action: "terminal-hard-reset" },
			{ type: "separator" },
			{ label: "Gauge Demo", action: "gauge-demo" },
			{ label: "Viewport Lab", action: "viewport-lab" },
			{ type: "separator" },
			{ label: "Zoom In", action: "zoom-in", accelerator: "=" },
			{ label: "Zoom Out", action: "zoom-out", accelerator: "-" },
			{ label: "Reset Zoom", action: "zoom-reset", accelerator: "0" },
			{ type: "separator" },
			{ role: "toggleFullScreen" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ type: "separator" },
			{ role: "bringAllToFront" },
			{ role: "cycleThroughWindows" },
			{ role: "close" },
		],
	},
]);

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

// Workaround: Electrobun/WKWebView clips the bottom ~16px of the viewport
// after a window resize. Trigger a resize nudge at startup so the app always
// starts in the "post-resize" state, making the pb-8 CSS padding reliable.
setTimeout(() => {
	try {
		const { width: w, height: h } = mainWindow.getSize();
		mainWindow.setSize(w, h - 1);
		setTimeout(() => {
			try { mainWindow.setSize(w, h); } catch { /* ignore */ }
		}, 50);
	} catch (err) {
		log.warn("Resize nudge failed", { error: String(err) });
	}
}, 200);

// Wire push messages to renderer
setPushMessage((name, payload) => {
	log.debug("Push to renderer", { name });
	(mainWindow.webview.rpc as any).send[name]?.(payload);
});

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

// Wire PTY death notifications
setOnPtyDied((taskId) => {
	try {
		log.info("PTY died, notifying renderer", { taskId: taskId.slice(0, 8) });
		(mainWindow.webview.rpc as any).send.ptyDied?.({ taskId });
	} catch (err) {
		log.error("Failed to notify renderer about PTY death", {
			taskId: taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}
});

// Wire terminal bell notifications
setOnBell((taskId) => {
	try {
		log.debug("Terminal bell, notifying renderer", { taskId: taskId.slice(0, 8) });
		(mainWindow.webview.rpc as any).send.terminalBell?.({ taskId });
		// Auto-move task from "in-progress" to "user-questions" on bell
		handleBellAutoStatus(taskId).catch((err) => {
			log.error("handleBellAutoStatus unhandled error", { error: String(err) });
		});
	} catch (err) {
		log.error("Failed to handle terminal bell", {
			taskId: taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}
});

// Wire terminal idle notifications (red badge only, no status transition)
// Only fires for tasks that are currently "in-progress" — idle terminals
// in other statuses (review, todo, etc.) are expected and not noteworthy.
setOnIdle((taskId) => {
	isTaskInProgress(taskId).then((inProgress) => {
		if (!inProgress) return;
		try {
			log.debug("Terminal idle, notifying renderer", { taskId: taskId.slice(0, 8) });
			(mainWindow.webview.rpc as any).send.terminalBell?.({ taskId });
		} catch (err) {
			log.error("Failed to handle terminal idle", {
				taskId: taskId.slice(0, 8),
				error: String(err),
			});
		}
	}).catch((err) => {
		log.error("isTaskInProgress failed in idle handler", { error: String(err) });
	});
});

mainWindow.on("close", () => {
	log.info("Main window closing, cleaning up");
	stopSocketServer();
	Utils.quit();
});

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

// --- Menu Event Handlers ---

Electrobun.events.on("application-menu-clicked", async (e) => {
	if (e.data.action === "hard-refresh") {
		log.info("Hard refresh — navigating to home page");
		mainWindow.webview.loadURL(url);
	} else if (e.data.action === "about") {
		Utils.showMessageBox({
			type: "info",
			title: "About",
			message: `dev-3.0 v${APP_VERSION}`,
			detail: "Terminal-centric project manager\nBuilt with Electrobun, React, and Bun.",
			buttons: ["OK"],
		});
	} else if (e.data.action === "open-settings") {
		(mainWindow.webview.rpc as any).send.navigateToSettings?.({});
	} else if (e.data.action === "gauge-demo") {
		(mainWindow.webview.rpc as any).send.navigateToGaugeDemo?.({});
	} else if (e.data.action === "viewport-lab") {
		(mainWindow.webview.rpc as any).send.navigateToViewportLab?.({});
	} else if (e.data.action === "check-for-updates") {
		try {
			const settings = await loadSettings();
			const result = await checkForUpdateWithChannel(settings.updateChannel);

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
					const dlResult = await downloadUpdateForChannel(settings.updateChannel);
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
		(mainWindow.webview.rpc as any).send.terminalSoftReset?.({});
	} else if (e.data.action === "terminal-hard-reset") {
		(mainWindow.webview.rpc as any).send.terminalHardReset?.({});
	} else if (e.data.action === "toggle-devtools") {
		mainWindow.webview.openDevTools();
	} else if (e.data.action === "zoom-in") {
		(mainWindow.webview.rpc as any).send.zoomIn?.({});
	} else if (e.data.action === "zoom-out") {
		(mainWindow.webview.rpc as any).send.zoomOut?.({});
	} else if (e.data.action === "zoom-reset") {
		(mainWindow.webview.rpc as any).send.zoomReset?.({});
	}
});

// --- Auto-Update Check ---

startAutoCheck(
	() => loadSettings().then((s) => s.updateChannel),
	async (version) => {
		log.info("Auto-check found update, downloading silently...", { version });
		const settings = await loadSettings();
		const dlResult = await downloadUpdateForChannel(settings.updateChannel);
		if (dlResult.ok) {
			log.info("Auto-download complete, notifying renderer", { version });
			(mainWindow.webview.rpc as any).send.updateAvailable?.({ version });
		} else {
			log.error("Auto-download failed", { error: dlResult.error });
		}
	},
);

log.info("=== dev-3.0 ready ===");
