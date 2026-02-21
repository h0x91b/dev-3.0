import Electrobun, {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	Updater,
	Utils,
} from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { handlers, setPushMessage } from "./rpc-handlers";
import { setOnPtyDied } from "./pty-server";
import { createLogger, getLogPath } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("main");

log.info("=== dev-3.0 starting ===");
log.info("All data at", { dir: DEV3_HOME });
log.info("Log files", { dir: getLogPath() });

// Side-effect: starts the PTY WebSocket server
import "./pty-server";

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
			{ label: "Toggle Developer Tools", action: "toggle-devtools" },
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
	title: "dev-3.0",
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
	log.info("PTY died, notifying renderer", { taskId: taskId.slice(0, 8) });
	(mainWindow.webview.rpc as any).send.ptyDied?.({ taskId });
});

mainWindow.on("close", () => {
	log.info("Main window closing, quitting app");
	Utils.quit();
});

// Open DevTools automatically on dev channel
mainWindow.webview.on("dom-ready", async () => {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		mainWindow.webview.openDevTools();
	}
	log.info("DOM ready");
});

// --- Menu Event Handlers ---

Electrobun.events.on("application-menu-clicked", (e) => {
	if (e.data.action === "about") {
		Utils.showMessageBox({
			type: "info",
			title: "About",
			message: "dev-3.0",
			detail: "Terminal-centric project manager\nBuilt with Electrobun, React, and Bun.",
			buttons: ["OK"],
		});
	} else if (e.data.action === "toggle-devtools") {
		mainWindow.webview.openDevTools();
	}
});

log.info("=== dev-3.0 ready ===");
