/**
 * Enrolling this browser for Web Push.
 *
 * Everything here answers one question the UI has to get right: can this browser
 * receive a push at all, and if not, why not — because the two ways it fails are
 * both silent. On iOS a Safari *tab* has no Notification API whatsoever, so a
 * user taps Enable, nothing happens, and the feature looks broken; and without a
 * valid certificate `serviceWorker.register` rejects.
 */

export type PushReadiness =
	| { ready: true }
	| { ready: false; reason: "insecure" | "needs-install" | "unsupported" };

const isIOS = (): boolean =>
	/iP(hone|ad|od)/.test(navigator.userAgent) ||
	// iPadOS 13+ reports as a Mac; the touch points give it away.
	(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isStandalone = (): boolean =>
	window.matchMedia("(display-mode: standalone)").matches ||
	(navigator as unknown as { standalone?: boolean }).standalone === true;

export function pushReadiness(): PushReadiness {
	if (!window.isSecureContext) return { ready: false, reason: "insecure" };
	// Order matters: on an iOS tab the APIs are absent *because* it is not
	// installed, and "add to Home Screen" is the actionable answer.
	if (isIOS() && !isStandalone()) return { ready: false, reason: "needs-install" };
	if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
		return { ready: false, reason: "unsupported" };
	}
	return { ready: true };
}

function b64urlToBytes(value: string): Uint8Array {
	const pad = "=".repeat((4 - (value.length % 4)) % 4);
	const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** A short human label so a device list is readable — never anything identifying. */
function deviceLabel(): string {
	const ua = navigator.userAgent;
	if (isIOS()) return "iPhone or iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Mac OS X/.test(ua)) return "Mac";
	if (/Windows/.test(ua)) return "Windows";
	return "Browser";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
	const registration = await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	return registration;
}

/**
 * Subscribe this browser and hand the subscription to the host. Returns the
 * endpoint so the caller can unsubscribe the same device later.
 */
export async function subscribeToPush(): Promise<string> {
	const registration = await registerServiceWorker();
	const res = await fetch("/push/key", { credentials: "same-origin" });
	if (!res.ok) throw new Error(`push key unavailable (${res.status})`);
	const { publicKey } = (await res.json()) as { publicKey: string };

	const existing = await registration.pushManager.getSubscription();
	// A stale subscription from a previous key would be rejected at send time
	// with no visible symptom, so replace rather than reuse.
	if (existing) await existing.unsubscribe().catch(() => {});

	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: b64urlToBytes(publicKey) as BufferSource,
	});

	try {
		const stored = await fetch("/push/subscribe", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subscription: subscription.toJSON(), label: deviceLabel() }),
		});
		if (!stored.ok) throw new Error(`could not register device (${stored.status})`);
		return subscription.endpoint;
	} catch (err) {
		await subscription.unsubscribe().catch(() => {});
		throw err;
	}
}

export async function unsubscribeFromPush(): Promise<void> {
	const registration = await navigator.serviceWorker.getRegistration("/sw.js");
	const subscription = await registration?.pushManager.getSubscription();
	if (!subscription) return;
	const removed = await fetch("/push/unsubscribe", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpoint: subscription.endpoint }),
	});
	if (!removed.ok) throw new Error(`could not unregister device (${removed.status})`);
	const unsubscribed = await subscription.unsubscribe();
	if (!unsubscribed) throw new Error("could not disable push in this browser");
}

export async function isSubscribed(): Promise<boolean> {
	if (!("serviceWorker" in navigator)) return false;
	const registration = await navigator.serviceWorker.getRegistration("/sw.js");
	return Boolean(await registration?.pushManager.getSubscription());
}
