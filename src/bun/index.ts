import Electrobun, {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	Updater,
	Utils,
} from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { handlers, setPushMessage, handleBellAutoStatus } from "./rpc-handlers";
import { startAutoCheck, checkForUpdateWithChannel, getLocalVersion, downloadUpdateForChannel, applyUpdate } from "./updater";
import { loadSettings } from "./settings";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { resolveShellEnv } from "./shell-env";
import { spawn } from "./spawn";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
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

const getISOWeek = (d: Date): number => {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

const formatDateTime = (d: Date) => {
	const date = d.toLocaleDateString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	const time = d.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return `${date} · W${String(getISOWeek(d)).padStart(2, "0")} · ${time}`;
};

const makeTitle = (dt: string) => `dev-3.0 v${APP_VERSION} [${dt}]`;

let lastBuildTime = BUILD_TIME;

log.info(`=== dev-3.0 starting [${lastBuildTime}] ===`);
log.info("All data at", { dir: DEV3_HOME });
log.info("Log files", { dir: getLogPath() });

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

// ── CLI script ──
// Write ~/.dev3.0/bin/dev3 launcher script. PATH is injected into
// worktree tmux sessions (see launchTaskPty), so no system symlink needed.
{
	const { existsSync: fExists, mkdirSync: fMkdir, writeFileSync: fWrite, chmodSync: fChmod } = await import("node:fs");
	const { resolve: fResolve, dirname: fDirname, join: fJoin } = await import("node:path");

	const cliBinDir = `${DEV3_HOME}/bin`;
	const cliScript = `${cliBinDir}/dev3`;

	try {
		fMkdir(cliBinDir, { recursive: true });

		// Find the project root by walking up from the app bundle.
		// In dev mode: import.meta.dir is inside build/.../app/ (Electrobun bundle).
		// We walk up until we find vite.config.ts to locate the source tree.
		let projectRoot = import.meta.dir;
		for (let i = 0; i < 20; i++) {
			if (fExists(fJoin(projectRoot, "vite.config.ts"))) break;
			const parent = fDirname(projectRoot);
			if (parent === projectRoot) break;
			projectRoot = parent;
		}

		let cliMainPath: string;
		const devCliPath = fJoin(projectRoot, "src", "cli", "main.ts");
		if (fExists(devCliPath)) {
			cliMainPath = devCliPath;
		} else {
			// Production fallback: CLI bundled next to the app module
			cliMainPath = fResolve(import.meta.dir, "..", "cli", "main.js");
		}

		const scriptContent = `#!/usr/bin/env bun\nimport "${cliMainPath}";\n`;
		fWrite(cliScript, scriptContent, "utf-8");
		fChmod(cliScript, 0o755);
		log.info("CLI script written", { path: cliScript, cliMainPath });
	} catch (err) {
		log.warn("CLI setup failed (non-fatal)", { error: String(err) });
	}
}

// ── Shell profile PATH injection ──
// Append ~/.dev3.0/bin to the user's shell RC file (idempotent).
// This makes `dev3` available in all terminals, not just worktree tmux sessions.
{
	const { existsSync: fExistsRc, readFileSync: fReadRc, appendFileSync: fAppendRc } = await import("node:fs");
	const shell = process.env.SHELL || "/bin/zsh";
	const home = process.env.HOME || "/tmp";
	const rcFile = shell.endsWith("bash") ? `${home}/.bashrc` : `${home}/.zshrc`;
	const marker = ".dev3.0/bin";
	try {
		const content = fExistsRc(rcFile) ? fReadRc(rcFile, "utf-8") : "";
		if (!content.includes(marker)) {
			fAppendRc(rcFile, `\n# dev3.0 CLI\nexport PATH="$HOME/.dev3.0/bin:$PATH"\n`, "utf-8");
			log.info("Shell profile updated with dev3 PATH", { rcFile });
		} else {
			log.info("Shell profile already contains dev3 PATH", { rcFile });
		}
	} catch (err) {
		log.warn("Failed to update shell profile (non-fatal)", { rcFile, error: String(err) });
	}
}

// Side-effect: starts the PTY WebSocket server (dynamic import so PATH is patched first)
const { setOnPtyDied, setOnBell } = await import("./pty-server");

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
			{ label: "Rebuild", action: "rebuild", accelerator: "r" },
			{ label: "Toggle Developer Tools", action: "toggle-devtools" },
			{ type: "separator" },
			{ label: "Soft Reset Terminal", action: "terminal-soft-reset" },
			{ label: "Hard Reset Terminal", action: "terminal-hard-reset" },
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

const mainWindow = new BrowserWindow({
	title: makeTitle(lastBuildTime),
	url,
	rpc,
	frame: {
		width: 1100,
		height: 800,
		x: 200,
		y: 200,
	},
});

log.info("Main window created");

// Wire push messages to renderer
setPushMessage((name, payload) => {
	log.debug("Push to renderer", { name });
	(mainWindow.webview.rpc as any).send[name]?.(payload);
});

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
		// Auto-move task to "user-questions" on first bell
		handleBellAutoStatus(taskId);
	} catch (err) {
		log.error("Failed to handle terminal bell", {
			taskId: taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}
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

// --- Menu Event Handlers ---

Electrobun.events.on("application-menu-clicked", async (e) => {
	if (e.data.action === "rebuild") {
		const { existsSync, cpSync, rmSync } = await import("fs");
		const { dirname, join } = await import("path");

		// Find project root by walking up from the bundle until we hit vite.config.ts
		let projectRoot = import.meta.dir;
		for (let i = 0; i < 20; i++) {
			if (existsSync(join(projectRoot, "vite.config.ts"))) break;
			const parent = dirname(projectRoot);
			if (parent === projectRoot) break;
			projectRoot = parent;
		}

		log.info("Rebuilding frontend...", { cwd: projectRoot });
		const proc = spawn(["bunx", "vite", "build"], {
			cwd: projectRoot,
			stdout: "inherit",
			stderr: "inherit",
		});
		await proc.exited;

		// Copy dist/ into the app bundle's views/ (mirrors electrobun.config.ts copy rules)
		const viewsDir = join(import.meta.dir, "..", "views", "mainview");
		const distDir = join(projectRoot, "dist");
		log.info("Copying dist to app bundle", { from: distDir, to: viewsDir });
		cpSync(join(distDir, "index.html"), join(viewsDir, "index.html"));
		rmSync(join(viewsDir, "assets"), { recursive: true, force: true });
		cpSync(join(distDir, "assets"), join(viewsDir, "assets"), { recursive: true });

		lastBuildTime = formatDateTime(new Date());
		log.info(`Rebuild done, reloading [${lastBuildTime}]`);
		mainWindow.setTitle(makeTitle(lastBuildTime));
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
	}
});

// --- Auto-Update Check ---

startAutoCheck(
	() => loadSettings().then((s) => s.updateChannel),
	async (version) => {
		log.info("Auto-check found update, downloading...", { version });
		const settings = await loadSettings();
		const dlResult = await downloadUpdateForChannel(settings.updateChannel);
		if (dlResult.ok) {
			log.info("Auto-download complete, showing restart dialog");
			const { response } = await Utils.showMessageBox({
				type: "info",
				title: "Update Ready",
				message: `Version ${version} has been downloaded`,
				detail: "Restart the app to apply the update.",
				buttons: ["Restart Now", "Later"],
				defaultId: 0,
				cancelId: 1,
			});
			if (response === 0) {
				await applyUpdate();
			}
		} else {
			log.error("Auto-download failed", { error: dlResult.error });
		}
	},
);

log.info("=== dev-3.0 ready ===");
