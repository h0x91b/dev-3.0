import Electrobun, {
	ApplicationMenu,
	BrowserWindow,
	Updater,
	Utils,
} from "electrobun/bun";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const PTY_WS_PORT = 7681;

// --- PTY WebSocket Server (Bun native terminal) ---

const shell = process.env.SHELL || "/bin/zsh";

Bun.serve({
	port: PTY_WS_PORT,
	fetch(req, server) {
		if (server.upgrade(req)) return;
		return new Response("PTY WebSocket server", { status: 200 });
	},
	websocket: {
		open(ws) {
			const cols = 80;
			const rows = 24;

			const proc = Bun.spawn([shell], {
				terminal: {
					cols,
					rows,
					data(_terminal, data) {
						try {
							// Convert Buffer to string — browser WebSocket
							// receives binary as Blob which is hard to handle
							const str =
								typeof data === "string"
									? data
									: new TextDecoder().decode(data);
							ws.sendText(str);
						} catch {
							// WebSocket already closed
						}
					},
				},
				env: {
					...process.env,
					TERM: "xterm-256color",
					HOME: process.env.HOME || "/",
				},
				cwd: process.env.HOME || "/",
			});

			(ws as any).proc = proc;

			proc.exited.then(() => {
				try {
					ws.close();
				} catch {
					// Already closed
				}
			});

			console.log(`PTY session started: ${shell} (pid: ${proc.pid})`);
		},
		message(ws, message) {
			const proc = (ws as any).proc as ReturnType<typeof Bun.spawn> | undefined;
			if (!proc?.terminal) return;

			const data =
				typeof message === "string"
					? message
					: new TextDecoder().decode(message);

			// Handle resize messages
			if (data.startsWith("\x1b]resize;")) {
				const match = data.match(/\x1b\]resize;(\d+);(\d+)\x07/);
				if (match) {
					proc.terminal.resize(Number(match[1]), Number(match[2]));
				}
				return;
			}

			proc.terminal.write(data);
		},
		close(ws) {
			const proc = (ws as any).proc as ReturnType<typeof Bun.spawn> | undefined;
			if (proc) {
				proc.terminal?.close();
				proc.kill();
				console.log("PTY session ended");
			}
		},
	},
});

console.log(`PTY WebSocket server running on ws://localhost:${PTY_WS_PORT}`);

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

// --- Application Menu ---

ApplicationMenu.setApplicationMenu([
	{
		label: "ghostty-web terminal",
		submenu: [
			{ label: "About ghostty-web terminal", action: "about" },
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
	title: "ghostty-web terminal",
	url,
	frame: {
		width: 900,
		height: 700,
		x: 200,
		y: 200,
	},
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
			message: "ghostty-web terminal",
			detail: "Version 0.0.1\nBuilt with Electrobun, React, and Bun.",
			buttons: ["OK"],
		});
	} else if (e.data.action === "toggle-devtools") {
		mainWindow.webview.openDevTools();
	}
});

console.log("ghostty-web terminal app started!");
