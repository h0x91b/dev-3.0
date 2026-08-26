/**
 * Registered push devices.
 *
 * A subscription is a capability to make someone's phone buzz, so registering
 * one is gated on an authenticated session at the route layer
 * (src/bun/remote-access-server.ts) and the file is 0600. Nothing here is
 * reachable from the desktop RPC surface.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import type { PushSubscription } from "./web-push";

const log = createLogger("web-push-store");

export const SUBSCRIPTIONS_FILE = `${DEV3_HOME}/web-push-subscriptions.json`;

export type StoredSubscription = PushSubscription & {
	/** Free-form, from the subscribing browser: "iPhone", "Firefox on Linux". */
	label?: string;
	createdAt: string;
};

export class MalformedPushSubscriptionError extends Error {
	constructor() {
		super("Malformed push subscription");
		this.name = "MalformedPushSubscriptionError";
	}
}

function isSubscription(v: unknown): v is StoredSubscription {
	if (!v || typeof v !== "object") return false;
	const s = v as Record<string, any>;
	return (
		typeof s.endpoint === "string" &&
		/^https:\/\//.test(s.endpoint) &&
		typeof s.keys?.p256dh === "string" &&
		typeof s.keys?.auth === "string"
	);
}

export function loadSubscriptions(path: string = SUBSCRIPTIONS_FILE): StoredSubscription[] {
	try {
		if (!existsSync(path)) return [];
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return Array.isArray(parsed) ? parsed.filter(isSubscription) : [];
	} catch (err) {
		log.warn("Ignoring unreadable subscription store", { path, error: String(err) });
		return [];
	}
}

export function saveSubscriptions(subs: StoredSubscription[], path: string = SUBSCRIPTIONS_FILE): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(subs, null, 2)}\n`, { mode: 0o600 });
	} catch (err) {
		log.warn("Could not persist subscriptions", { path, error: String(err) });
		throw new Error("Could not persist push subscriptions");
	}
}

/** The endpoint is the device's identity: re-subscribing the same device must
 *  replace its entry, not add a second one that double-buzzes. */
export function addSubscription(sub: unknown, label: string | undefined, path: string = SUBSCRIPTIONS_FILE, now = new Date()): StoredSubscription[] {
	if (!isSubscription(sub)) throw new MalformedPushSubscriptionError();
	const rest = loadSubscriptions(path).filter((s) => s.endpoint !== sub.endpoint);
	const next: StoredSubscription[] = [
		...rest,
		{ endpoint: sub.endpoint, keys: sub.keys, ...(label ? { label } : {}), createdAt: now.toISOString() },
	];
	saveSubscriptions(next, path);
	return next;
}

export function removeSubscription(endpoint: string, path: string = SUBSCRIPTIONS_FILE): StoredSubscription[] {
	const next = loadSubscriptions(path).filter((s) => s.endpoint !== endpoint);
	saveSubscriptions(next, path);
	return next;
}
