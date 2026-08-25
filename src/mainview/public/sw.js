// Service worker for Web Push. Deliberately minimal: it must survive being woken
// from cold by the push service with the app closed, so it caches nothing and
// holds no state of its own.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		// A payload we cannot parse still has to raise something: userVisibleOnly
		// means the browser shows its own "site updated in the background" notice
		// otherwise, which is worse than a generic one of ours.
	}
	const title = data.title || "dev-3.0";
	event.waitUntil(
		self.registration.showNotification(title, {
			body: data.body || "",
			// Collapse repeats for one task on the device itself.
			tag: data.taskId || "dev3",
			data,
			icon: "/favicon.png",
			badge: "/favicon-32.png",
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = event.notification.data || {};
	const url = target.taskId && target.projectId ? `/?project=${target.projectId}&task=${target.taskId}` : "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			for (const client of list) {
				if ("focus" in client) {
					if ("navigate" in client && url !== "/") client.navigate(url).catch(() => {});
					return client.focus();
				}
			}
			return self.clients.openWindow(url);
		}),
	);
});
