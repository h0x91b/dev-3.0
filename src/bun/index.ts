import Electrobun, {
	ApplicationMenu,
	PATHS,
	Updater,
	Utils,
} from "electrobun/bun";
import { handlers, setPushMessage, getPushMessage, handleBellAutoStatus, isTaskInProgress, startMergeDetectionPoller, startPRDetectionPoller, handlePaneExited, consumeRecentWatchedNotification, setAppForeground, setFocusMode, pushTerminalBell } from "./rpc-handlers";
import { startAutoCheck, checkForUpdateWithChannel, getLocalVersion, downloadUpdateForChannel } from "./updater";
import { loadSettings, loadSettingsSync } from "./settings";
import { installSignalQuitConfirmation, isQuitConfirmed, markQuitDialogPending } from "./quit-manager";
import { initNativeNotifications } from "./native-notifications";
import { markPendingNotificationNav } from "./notification-nav";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { applyFullShellEnvToProcess, getShellRcFiles, getUserShell, resolveShellEnv } from "./shell-env";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
import { startRemoteAccessServer, pushToBrowserClients } from "./remote-access-server";
import { writeSystemClipboard } from "./system-clipboard";
import { stopTunnel } from "./cloudflare-tunnel";
import { installAgentSkills } from "./agent-skills";
import { ensureCodexConfigFile } from "./codex-config";
import { makeTitle } from "./app-utils";
import { buildApplicationMenu, getMenuContext, MENU_ACTIONS, onMenuContextChange } from "../shared/application-menu";
import { openLogsDirectory } from "./menu-actions";
import { startLoopMonitor } from "./loop-monitor";
import { createAppWindow, broadcastToAllWindows, focusFocusedWindow, getFocusedWindow, getWindowCount, sendToFocusedWindow, setOpenNewWindow, flushWindowState } from "./window-manager";
import electrobunConfig from "../../electrobun.config";
import { BUILD_TIME } from "../shared/build-info.generated";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { rehydrateTaskLifecycles } from "./lifecycle/rehydrate";

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

// NOTE: We deliberately do NOT process.chdir() away from the .app bundle.
// electrobun resolves native resources and the `views://` protocol relative to
// process.cwd(), so moving cwd blanks the desktop window ("Resource not found").
// The brew-upgrade/in-app-update ENOENT hazard it was meant to fix — a child
// inheriting a since-deleted bundle cwd — is instead handled in spawn.ts, which
// pins cwd-less children to DEV3_HOME without ever moving the process. See
// decision 109.

// ── CLI binary + agent skills + shell PATH (FIRST — before any async work) ──
// These must run before resolveShellEnv() because existing tmux sessions
// (from a previous app instance) may already have agents trying to use the CLI.
// resolveShellEnv() can take 5-30s on machines with heavy .zshrc — installing
// the CLI after it means agents hit "no such file or directory" on startup.
{
	const { existsSync: fExists, mkdirSync: fMkdir, copyFileSync: fCopy, chmodSync: fChmod,
		readFileSync: fRead, appendFileSync: fAppend, renameSync: fRename, unlinkSync: fUnlink } = await import("node:fs");
	const { resolve: fResolve } = await import("node:path");

	// Copy the compiled CLI binary from the app bundle to ~/.dev3.0/bin/.
	// A single binary ships: `dev3` is both the CLI and — via `dev3 remote` — the
	// headless server (the server is bundled behind a dynamic import; see
	// src/cli/commands/remote.ts). Overwritten on every start so it always
	// matches the running app version.
	// Production: PATHS.VIEWS_FOLDER (<bundle>/Resources/app/views/) → ../cli/<name>
	// Dev fallback: import.meta.dir (src/bun/) → ../cli/<name>
	const cliBinDir = `${DEV3_HOME}/bin`;
	const installBinary = (name: string): void => {
		const prodSrc = fResolve(PATHS.VIEWS_FOLDER, "..", "cli", name);
		const devSrc = fResolve(import.meta.dir, "..", "cli", name);
		const bundledSrc = fExists(prodSrc) ? prodSrc : devSrc;
		const dest = `${cliBinDir}/${name}`;
		try {
			fMkdir(cliBinDir, { recursive: true });
			if (fExists(bundledSrc)) {
				// Write to a temp sibling, chmod it, then atomically rename over the
				// live path. copyFileSync truncates the destination in place, so an
				// agent exec'ing `dev3` mid-copy (a real possibility — ~/.dev3.0 is
				// shared across concurrently-running app instances, and every start
				// rewrites this) could hit a partial binary → ENOEXEC. rename() is
				// atomic within the same filesystem. (Same tmp+rename pattern as the
				// data-layer atomic writes in data.ts.)
				const tmpDest = `${dest}.tmp-${process.pid}`;
				try {
					fCopy(bundledSrc, tmpDest);
					fChmod(tmpDest, 0o755);
					fRename(tmpDest, dest);
				} catch (copyErr) {
					try { fUnlink(tmpDest); } catch { /* best-effort cleanup */ }
					throw copyErr;
				}
				log.info(`${name} binary installed`, { from: bundledSrc, to: dest });
			} else {
				log.warn(`${name} binary not found in bundle (skip)`, { prodSrc, devSrc });
			}
		} catch (err) {
			log.warn(`${name} setup failed (non-fatal)`, { error: String(err) });
		}
	};

	installBinary("dev3");

	// Install dev3 skill into all supported AI agent directories (~/.claude, ~/.codex, etc.).
	// Overwritten on every start to match the running app version (same pattern as CLI binary).
	installAgentSkills({ configureCodex: false });

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

// Codex profile migration depends on `codex --version`. Run it only after the
// user's shell PATH is available; the app bundle starts with a minimal PATH.
ensureCodexConfigFile(homedir());

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

applyFullShellEnvToProcess(shellEnv, (await loadSettings()).importShellEnv !== false);

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

// Exclude the worktrees root from OS backups (Time Machine) once at startup.
// Best-effort; no-op on Linux and when disabled in settings.
{
	const { ensureWorktreesBackupExclusion } = await import("./backup-exclusion");
	ensureWorktreesBackupExclusion().catch((err) => {
		log.warn("Startup backup exclusion failed (non-fatal)", { err });
	});
}

// Side-effect: starts the PTY WebSocket server (dynamic import so PATH is patched first)
const { setOnPtyDied, setOnBell, setOnIdle, setOnPaneExited, setOnOsc52Copy, getActiveSessionIds, getPtyPort } = await import("./pty-server");
const { startPortScanPoller, stopPortScanPoller } = await import("./port-scanner");
const { startResourceMonitor, stopResourceMonitor } = await import("./resource-monitor");
const { startRateLimitMonitor, stopRateLimitMonitor } = await import("./rate-limit-monitor");

// Pin the tmux binary before any poller talks to the tmux server — the bare
// PATH `tmux` may be a version the running server rejects, or missing entirely
// (keg-only tmux@3.6 install). Fire-and-forget: the renderer's requirements
// check re-runs the same selection later, and both are idempotent.
{
	const { resolveTmuxBinaryAtStartup } = await import("./rpc-handlers/settings-config");
	resolveTmuxBinaryAtStartup().catch((err) => {
		log.warn("Startup tmux binary resolution failed (non-fatal)", { err: String(err) });
	});
}

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// --- Main Window ---

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	log.info("App channel", { channel });
	if (channel === "dev") {
		try {
			// Bound the probe: fetch() has no default timeout, so a process that
			// accepts the connection on 5173 but never answers would hang this
			// await forever — and the window is opened after it, so the app would
			// boot to nothing. A short timeout falls back to bundled assets.
			await fetch(DEV_SERVER_URL, { method: "HEAD", signal: AbortSignal.timeout(1000) });
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
	const buildChannel = await Updater.localInfo.channel();
	return createAppWindow({
		title: makeTitle(APP_VERSION, lastBuildTime, buildChannel),
		url,
		handlers: handlers as unknown as Record<string, (...args: unknown[]) => unknown>,
		onDomReady: async (win) => {
			if (buildChannel === "dev") {
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

// Initialize the backend gate before background pollers and CLI requests can
// raise agent notifications. Queued entries flush when Focus Mode is disabled.
setFocusMode(loadSettingsSync().focusMode === true);

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

// Reconcile persisted lifecycle hints before background activity starts.
await rehydrateTaskLifecycles();

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

// Start background agent rate-limit monitor (Claude dump / Codex rollouts + monthly credits)
startRateLimitMonitor((name, payload) => {
	try {
		broadcastToAllWindows(name, payload);
	} catch (err) {
		log.error("Failed to push rate-limit update", { error: String(err) });
	}
});

// Start the Automations scheduler (scheduled agent runs). The first tick also
// detects occurrences missed while the app was offline and surfaces them.
// Runs in headless (`dev3 remote`) too — same main process.
const { startAutomationsScheduler } = await import("./automations-scheduler");
startAutomationsScheduler();

// Start the scheduled-launch scheduler ("Start in…" deferred task launches).
// One-shot fires; the first tick catches up launches that came due offline.
const { startScheduledLaunchScheduler } = await import("./scheduled-launch-scheduler");
startScheduledLaunchScheduler();

// Start the scheduled-message scheduler ("Send later" — deliver a queued prompt
// into a task's live agent). One-shot; the first tick catches up messages that
// came due while the app was offline (fires late + notifies).
const { startScheduledMessageScheduler } = await import("./scheduled-message-scheduler");
startScheduledMessageScheduler();

// Start the focus tracker — accumulates real UI attention time per task (the
// "your time" metric on the Productivity dashboard) from the foreground +
// idle + active-context signals the renderer already reports. Runs headless too.
const { startFocusTracker, stopFocusTracker } = await import("./focus-tracker");
startFocusTracker();

// Wire PTY death notifications
setOnPtyDied((sessionKey) => {
	try {
		if (sessionKey.startsWith("project-")) {
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
		// Project terminals are plain shells — skip bell/auto-status logic
		if (sessionKey.startsWith("project-")) return;

		log.debug("Terminal bell, notifying renderer", { taskId: sessionKey.slice(0, 8) });
		pushTerminalBell(sessionKey);
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
	// Project terminals have no task status — skip idle notifications
	if (sessionKey.startsWith("project-")) return;

	isTaskInProgress(sessionKey).then((inProgress) => {
		if (!inProgress) return;
		try {
			log.debug("Terminal idle, notifying renderer", { taskId: sessionKey.slice(0, 8) });
			pushTerminalBell(sessionKey);
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
	// Snapshot window geometry so an update restart reopens on the same screen.
	try { flushWindowState(); } catch (err) { log.warn("flushWindowState failed", { error: String(err) }); }
	try { stopPortScanPoller(); } catch (err) { log.warn("stopPortScanPoller failed", { error: String(err) }); }
	try { stopFocusTracker(); } catch (err) { log.warn("stopFocusTracker failed", { error: String(err) }); }
	try { stopResourceMonitor(); } catch (err) { log.warn("stopResourceMonitor failed", { error: String(err) }); }
	try { stopRateLimitMonitor(); } catch (err) { log.warn("stopRateLimitMonitor failed", { error: String(err) }); }
	try { stopSocketServer(); } catch (err) { log.warn("stopSocketServer failed", { error: String(err) }); }
	// Tear down every per-task cloudflared process spawned by the GUI's
	// `Expose port` button or by `--expose-ports`. Leaving them running
	// would orphan tunnels (and trycloudflare quotas) on app exit.
	import("./port-tunnels").then(({ cleanupAllTunnels }) => cleanupAllTunnels()).catch(() => { /* shutdown — best-effort */ });
	try { stopTunnel(); } catch (err) { log.warn("stopTunnel failed", { error: String(err) }); }
}

// Terminal/OS signals (Ctrl+C in `bun run dev`, kill, shutdown) bypass the
// quit dialog below — they mark the quit confirmed before Electrobun's own
// SIGINT/SIGTERM handlers call Utils.quit().
installSignalQuitConfirmation();

// Single quit gate for EVERY quit trigger — Cmd+Q, menu Quit, closing the last
// window (red X / Cmd+W), updater restart. Fires once per attempt.
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

// Click-to-open for task notifications — native channel (macOS).
//
// The compiled shim (src/native/macos/dev3-notifications.m) owns a
// UNUserNotificationCenterDelegate: a click hands us the exact task that fired
// the notification, whenever it happens — no timing heuristics. When the shim
// is active, shared.ts posts notifications through it and never arms the
// focus-proxy slot below.
const nativeNotificationClicks = initNativeNotifications((target) => {
	log.info("[notif] native notification click", { taskId: target.taskId.slice(0, 8), projectId: target.projectId.slice(0, 8) });
	if (getWindowCount() === 0) {
		// App sits window-less in the dock: reopen a window; the renderer pulls
		// the target on mount via consumePendingNotificationNav (a push would race
		// its not-yet-registered listener).
		markPendingNotificationNav(target);
		void openMainWindow();
		return;
	}
	// macOS already activates the app on notification click; make sure a window
	// is key (e.g. it was miniaturized) and navigate.
	focusFocusedWindow();
	sendToFocusedWindow("openTaskFromNotification", target);
});
log.info(`[notif] click channel: ${nativeNotificationClicks ? "native delegate" : "focus-proxy fallback"}`);

// Click-to-open FALLBACK (Linux, headless dylib-less builds, or notification
// permission denied — cases where the native channel above reports false and
// shared.ts posts via Electrobun's Utils.showNotification instead).
// That path has no click callback, so we treat any "app became foreground"
// signal that arrives shortly after a notification fired as a click-through.
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
					broadcastToAllWindows("updateAvailable", { version: result.version, changelog: result.changelog });
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
			// Fetch only the local QR (no blocking tunnel handshake) so the
			// modal opens instantly; the renderer brings the tunnel up next.
			const remoteAccess = await handlers.getRemoteAccessQR({ tunnel: false });
			sendToFocusedWindow("showRemoteAccessQR", { ...remoteAccess, autoStartTunnel: true });
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
	async (version, changelog) => {
		log.info("Auto-check found update, downloading silently...", { version });
		const settings = await loadSettings();
		sendUpdateProgress("downloading", 0);
		const dlResult = await downloadUpdateForChannel(settings.updateChannel, sendUpdateProgress);
		if (dlResult.ok) {
			log.info("Auto-download complete, notifying renderer", { version });
			broadcastToAllWindows("updateAvailable", { version, changelog });
		} else {
			log.error("Auto-download failed", { error: dlResult.error });
			sendUpdateProgress("error");
		}
	},
	sendUpdateProgress,
);

log.info("=== dev-3.0 ready ===");
