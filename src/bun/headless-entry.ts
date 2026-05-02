/**
 * Headless entry point for `dev3 remote`.
 *
 * This is a mirror of `src/bun/index.ts` that skips everything GUI-specific
 * (BrowserWindow, ApplicationMenu, Screen, Electrobun.events, auto-update UI).
 * The RPC handler surface, PTY server, CLI socket, git pollers, port scanner,
 * and resource monitor are identical — only the shell is replaced by the
 * remote-access HTTP/WS server which any browser can connect to.
 *
 * IMPORTANT: the DEV3_HEADLESS=1 env flag must be set BEFORE this module is
 * imported — ES module imports hoist so you can't set it here. The entrypoint
 * that boots us, `src/bun/headless-bootstrap.ts`, takes care of it; never run
 * this file directly. The spawn logic in `src/cli/commands/remote.ts` sets
 * the flag on the child env as belt-and-suspenders.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { handlers, setPushMessage, getPushMessage, handleBellAutoStatus, isTaskInProgress, startMergeDetectionPoller, startPRDetectionPoller, handlePaneExited } from "./rpc-handlers";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";
import { getUserShell, resolveShellEnv } from "./shell-env";
import { startSocketServer, stopSocketServer } from "./cli-socket-server";
import { startRemoteAccessServer, pushToBrowserClients, getServerPort, getAccessUrl } from "./remote-access-server";
import { startTunnel, stopTunnel, isCloudflaredAvailable, getTunnelUrl } from "./cloudflare-tunnel";
import { renderHeadlessBanner, startQrAutoRefresh, stopQrAutoRefresh, markQrConsumed } from "./remote-console";
import { BUILD_TIME, BUILD_VERSION } from "../shared/build-info.generated";

const log = createLogger("headless");

// ── Global crash handlers ─────────────────────────────────────────
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

log.info(`=== dev-3.0 headless starting [${BUILD_TIME}] v${BUILD_VERSION} ===`);
log.info("All data at", { dir: DEV3_HOME });
log.info("Log files", { dir: getLogPath() });

// ── Options (from DEV3_REMOTE_* env, set by the `dev3 remote` CLI command) ──
const wantTunnel = process.env.DEV3_REMOTE_TUNNEL === "1";

// ── Resolve DEV3_VIEWS_DIR if not already set ──
// remote-access-server uses PATHS.VIEWS_FOLDER (backed by DEV3_VIEWS_DIR env in
// headless mode) to serve the Vite build. We probe a few common layouts:
//
//   tarball release:  <bin-dir>/dev3 + <bin-dir>/dist           (CLI tarball)
//   FHS install:      <bin-dir>/dev3 + <prefix>/share/dev-3.0/dist
//   dev mode:         src/bun/headless-entry.ts  → <repo>/dist
//   electrobun bundle: <bin-dir>/dev3-server     → <bin-dir>/dist
//   CWD fallback:     ./dist (last resort)
//
// `process.execPath` resolves to the on-disk binary even when launched via a
// symlink (e.g. brew's bin → libexec). `import.meta.dir` is virtual inside
// bun-compiled bundles, so it only matters in dev mode.
if (!process.env.DEV3_VIEWS_DIR) {
	let execDir = "";
	try {
		execDir = dirname(realpathSync(process.execPath));
	} catch { /* unreadable execPath — skip and rely on the other candidates */ }
	const candidates = [
		execDir && resolve(execDir, "dist"),                        // tarball
		execDir && resolve(execDir, "..", "share", "dev-3.0", "dist"), // brew/FHS
		resolve(import.meta.dir, "..", "..", "dist"),               // dev mode
		resolve(import.meta.dir, "..", "dist"),                     // older bundles
		resolve(process.cwd(), "dist"),                             // CWD fallback
	].filter(Boolean) as string[];
	for (const candidate of candidates) {
		if (existsSync(resolve(candidate, "index.html"))) {
			process.env.DEV3_VIEWS_DIR = candidate;
			log.info("DEV3_VIEWS_DIR resolved", { dir: candidate });
			break;
		}
	}
	if (!process.env.DEV3_VIEWS_DIR) {
		log.warn("Could not locate dist/ with index.html", { candidates });
	}
}

// ── Resolve shell PATH + LANG + key gh config vars (same as GUI entry) ──
process.env.SHELL = getUserShell();
const originalPath = process.env.PATH;
const originalLang = process.env.LANG;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalGhConfigDir = process.env.GH_CONFIG_DIR;
const shellEnv = await resolveShellEnv();
if (shellEnv.path) {
	process.env.PATH = shellEnv.path;
	log.info("Shell PATH resolved", { original: originalPath, resolved: shellEnv.path });
} else {
	log.warn("Could not resolve shell PATH, using original", { path: originalPath });
}

{
	const home = process.env.HOME;
	if (home) {
		const userBinDirs = [`${home}/.local/bin`, `${home}/bin`];
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
	log.info("Shell LANG resolved", { original: originalLang, resolved: shellEnv.lang });
} else if (!process.env.LANG) {
	process.env.LANG = "en_US.UTF-8";
}

if (shellEnv.xdgConfigHome) {
	process.env.XDG_CONFIG_HOME = shellEnv.xdgConfigHome;
	log.info("Shell XDG_CONFIG_HOME resolved", { original: originalXdgConfigHome, resolved: shellEnv.xdgConfigHome });
}

if (shellEnv.ghConfigDir) {
	process.env.GH_CONFIG_DIR = shellEnv.ghConfigDir;
	log.info("Shell GH_CONFIG_DIR resolved", { original: originalGhConfigDir, resolved: shellEnv.ghConfigDir });
}

// ── CLI socket server (required — CLI tool talks to the app over this) ──
const cliSocketPath = startSocketServer();
log.info("CLI socket server ready", { path: cliSocketPath });

// ── PTY / port scanner / resource monitor (dynamic import so PATH is patched first) ──
const { setOnPtyDied, setOnBell, setOnIdle, setOnPaneExited, setOnOsc52Copy, getActiveSessionIds, getPtyPort } = await import("./pty-server");
const { startPortScanPoller, stopPortScanPoller } = await import("./port-scanner");
const { startResourceMonitor, stopResourceMonitor } = await import("./resource-monitor");

// ── Wire push messages (browser clients only — no Electrobun webview here) ──
setPushMessage((name, payload) => {
	if (name === "qrTokenConsumed") {
		markQrConsumed();
	}
	pushToBrowserClients(name, payload);
});

// ── Remote-access HTTP + WebSocket server ──
await startRemoteAccessServer({
	rpcHandler: async (method: string, params: unknown) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const handler = (handlers as any)[method];
		if (!handler) throw new Error(`Unknown RPC method: ${method}`);
		return await handler(params);
	},
	getPtyPort,
	onQrTokenConsumed: () => {
		getPushMessage()?.("qrTokenConsumed", {});
	},
});

// ── Optional: Cloudflare tunnel (opt-in via --tunnel flag → DEV3_REMOTE_TUNNEL=1) ──
if (wantTunnel) {
	if (!isCloudflaredAvailable()) {
		console.error("\n[dev3 remote] --tunnel requested but `cloudflared` is not installed.");
		console.error("              Install it from https://github.com/cloudflare/cloudflared\n");
	} else {
		console.log("[dev3 remote] Starting Cloudflare tunnel...");
		const tunnelUrl = await startTunnel(getServerPort());
		if (tunnelUrl) {
			console.log(`[dev3 remote] Tunnel ready: ${tunnelUrl}`);
		} else {
			console.error("[dev3 remote] Tunnel failed to start — falling back to local-only URL");
		}
	}
}

// ── Banner + QR + auto-refresh ──
const staticCode = process.env.DEV3_REMOTE_STATIC_CODE || null;
await renderHeadlessBanner({
	port: getServerPort(),
	tunnelUrl: getTunnelUrl(),
	tunnelRequested: wantTunnel,
	accessUrl: await getAccessUrl(),
	staticCode,
});
// Skip the rolling JWT refresh when a static code is in effect — the URL is
// stable, so there is nothing to refresh.
if (!staticCode) {
	startQrAutoRefresh(() => getAccessUrl());
}

// ── Background pollers ──
startMergeDetectionPoller();
startPRDetectionPoller();

startPortScanPoller(
	(name, payload) => {
		pushToBrowserClients(name, payload);
	},
	getActiveSessionIds,
);

startResourceMonitor((name, payload) => {
	pushToBrowserClients(name, payload);
});

// ── PTY event wiring (no mainWindow.webview.rpc — just push to browser) ──
setOnPtyDied((sessionKey) => {
	try {
		if (sessionKey === "home") {
			log.info("Home terminal died");
			pushToBrowserClients("homePtyDied", {});
		} else if (sessionKey.startsWith("project-")) {
			const projectId = sessionKey.slice(8);
			log.info("Project terminal died", { projectId: projectId.slice(0, 8) });
			pushToBrowserClients("projectPtyDied", { projectId });
		} else {
			log.info("PTY died", { taskId: sessionKey.slice(0, 8) });
			pushToBrowserClients("ptyDied", { taskId: sessionKey });
		}
	} catch (err) {
		log.error("Failed to notify about PTY death", { sessionKey: sessionKey.slice(0, 8), error: String(err) });
	}
});

setOnBell((sessionKey) => {
	try {
		if (sessionKey === "home") return;
		if (sessionKey.startsWith("project-")) return;
		log.debug("Terminal bell", { taskId: sessionKey.slice(0, 8) });
		pushToBrowserClients("terminalBell", { taskId: sessionKey });
		handleBellAutoStatus(sessionKey).catch((err) => {
			log.error("handleBellAutoStatus failed", { error: String(err) });
		});
	} catch (err) {
		log.error("Failed to handle terminal bell", { taskId: sessionKey.slice(0, 8), error: String(err) });
	}
});

setOnIdle((sessionKey) => {
	if (sessionKey === "home") return;
	if (sessionKey.startsWith("project-")) return;
	isTaskInProgress(sessionKey).then((inProgress) => {
		if (!inProgress) return;
		try {
			pushToBrowserClients("terminalBell", { taskId: sessionKey });
		} catch (err) {
			log.error("Failed to handle terminal idle", { taskId: sessionKey.slice(0, 8), error: String(err) });
		}
	}).catch((err) => {
		log.error("isTaskInProgress failed in idle handler", { error: String(err) });
	});
});

setOnOsc52Copy((payload) => {
	try {
		pushToBrowserClients("osc52Clipboard", payload);
	} catch (err) {
		log.error("Failed to forward OSC 52 clipboard payload", {
			taskId: payload.taskId.slice(0, 8),
			error: String(err),
		});
	}
});

setOnPaneExited((taskId, paneId) => {
	handlePaneExited(taskId, paneId).catch((err) => {
		log.error("handlePaneExited failed", { error: String(err) });
	});
});

// ── Graceful shutdown ──
function shutdown(signal: string): void {
	log.info(`Received ${signal}, shutting down`);
	stopQrAutoRefresh();
	stopPortScanPoller();
	stopResourceMonitor();
	stopSocketServer();
	stopTunnel();
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info("=== dev-3.0 headless ready ===");
