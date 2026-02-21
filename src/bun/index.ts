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

// Side-effect: starts the PTY WebSocket server
import "./pty-server";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// --- Main Window ---

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'bun run dev' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

const url = await getMainViewUrl();

// --- RPC ---

const rpc = BrowserView.defineRPC<AppRPCSchema>({
	maxRequestTime: 30000,
	handlers: {
		requests: handlers,
		messages: {},
	},
});

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

// Wire push messages to renderer
setPushMessage((name, payload) => {
	(mainWindow.webview.rpc as any).send[name]?.(payload);
});

// Wire PTY death notifications
setOnPtyDied((taskId) => {
	(mainWindow.webview.rpc as any).send.ptyDied?.({ taskId });
});

mainWindow.on("close", () => {
	Utils.quit();
});

// Open DevTools automatically on dev channel
mainWindow.webview.on("dom-ready", async () => {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		mainWindow.webview.openDevTools();
	}
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

console.log("dev-3.0 app started!");
