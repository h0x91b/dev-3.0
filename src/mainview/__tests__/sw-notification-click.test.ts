import { readFileSync } from "node:fs";
import { join } from "node:path";

type Listener = (event: unknown) => void;

/** Runs the real `sw.js` against a fake worker scope and returns its listeners. */
function loadServiceWorker(clients: Array<{ url: string; focus: () => Promise<unknown>; navigate: (url: string) => Promise<unknown> }>) {
	const listeners: Record<string, Listener> = {};
	const openWindow = vi.fn(async (_url: string) => null);
	const self = {
		addEventListener: (type: string, listener: Listener) => {
			listeners[type] = listener;
		},
		clients: { matchAll: async () => clients, openWindow, claim: async () => {} },
		registration: { showNotification: async () => {} },
		skipWaiting: async () => {},
	};
	const source = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
	new Function("self", source)(self);
	return { listeners, openWindow };
}

function windowClient(url: string) {
	return { url, focus: vi.fn(async () => undefined), navigate: vi.fn(async (_url: string) => undefined) };
}

async function clickNotification(listeners: Record<string, Listener>) {
	let done: Promise<unknown> = Promise.resolve();
	listeners.notificationclick({
		notification: { close: () => {}, data: { projectId: "p1", taskId: "t1" } },
		waitUntil: (promise: Promise<unknown>) => {
			done = promise;
		},
	});
	await done;
}

describe("sw.js notification click", () => {
	it("never turns a file opened in its own tab into the app", async () => {
		const fileTab = windowClient("https://dev3.example/file/tok/clip.mp4");
		const blankTab = windowClient("about:blank");
		const appTab = windowClient("https://dev3.example/?project=p1");
		const { listeners } = loadServiceWorker([fileTab, blankTab, appTab]);
		await clickNotification(listeners);
		expect(fileTab.navigate).not.toHaveBeenCalled();
		expect(blankTab.navigate).not.toHaveBeenCalled();
		expect(appTab.navigate).toHaveBeenCalledWith("/?project=p1&task=t1");
		expect(appTab.focus).toHaveBeenCalled();
	});

	it("opens a new window when only file tabs are open", async () => {
		const fileTab = windowClient("https://dev3.example/file/tok/report.html");
		const { listeners, openWindow } = loadServiceWorker([fileTab]);
		await clickNotification(listeners);
		expect(fileTab.navigate).not.toHaveBeenCalled();
		expect(openWindow).toHaveBeenCalledWith("/?project=p1&task=t1");
	});
});
