/**
 * One distinct id per install (seq 1470). posthog-js mints an id per renderer, so
 * without this the desktop window and a remote browser are two persons of the
 * same machine and a percentage rollout can half-enable it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { store } = vi.hoisted(() => ({ store: { settings: {} as Record<string, unknown> } }));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ ...store.settings })),
	loadSettingsSync: vi.fn(() => ({ ...store.settings })),
	saveSettings: vi.fn(async (next: Record<string, unknown>) => { store.settings = { ...next }; }),
}));

import { analyticsDistinctIdSync, distinctIdBootstrapScript, resolveAnalyticsDistinctId } from "../analytics-identity";

beforeEach(() => {
	store.settings = {};
	vi.clearAllMocks();
});

describe("analytics distinct id", () => {
	it("adopts the seed the first renderer offers, so an existing person survives", async () => {
		const id = await resolveAnalyticsDistinctId("existing-posthog-id");
		expect(id).toBe("existing-posthog-id");
		expect(store.settings.analyticsDistinctId).toBe("existing-posthog-id");
	});

	it("mints one when no renderer has an id to offer", async () => {
		const id = await resolveAnalyticsDistinctId(undefined);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("ignores a blank seed rather than storing an empty id", async () => {
		const id = await resolveAnalyticsDistinctId("   ");
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("hands every later caller the same id, whatever seed they bring", async () => {
		const first = await resolveAnalyticsDistinctId("desktop-id");
		const second = await resolveAnalyticsDistinctId("browser-id");
		expect(second).toBe(first);
	});

	// bootstrap.distinctID loses to a renderer that already has its own identity, so
	// a browser with history keeps evaluating as itself. If it also owned the stored
	// id, the desktop window would be targeted at an id it never evaluates as.
	it("lets the desktop renderer take the identity back from a browser", async () => {
		await resolveAnalyticsDistinctId("browser-with-history", { authoritative: false });
		const id = await resolveAnalyticsDistinctId("desktop-id", { authoritative: true });
		expect(id).toBe("desktop-id");
		expect(store.settings.analyticsDistinctId).toBe("desktop-id");
	});

	it("keeps the stored id when the authoritative renderer reports the same one", async () => {
		await resolveAnalyticsDistinctId("desktop-id", { authoritative: true });
		const id = await resolveAnalyticsDistinctId("desktop-id", { authoritative: true });
		expect(id).toBe("desktop-id");
	});

	it("ignores an authoritative caller with no id of its own, rather than minting a second", async () => {
		await resolveAnalyticsDistinctId("existing-id");
		const id = await resolveAnalyticsDistinctId(undefined, { authoritative: true });
		expect(id).toBe("existing-id");
	});

	it("reads without minting, so rendering the HTML shell cannot create an id", () => {
		expect(analyticsDistinctIdSync()).toBeNull();
		expect(store.settings.analyticsDistinctId).toBeUndefined();
	});

	it("exposes the stored id to the HTML shell once it exists", async () => {
		await resolveAnalyticsDistinctId("desktop-id");
		expect(analyticsDistinctIdSync()).toBe("desktop-id");
	});
});

describe("renderer bootstrap script", () => {
	it("hands the id over as one global assignment", async () => {
		await resolveAnalyticsDistinctId("desktop-id");
		expect(distinctIdBootstrapScript()).toBe('window.__DEV3_DISTINCT_ID__="desktop-id";');
	});

	it("stays empty before an id exists, so the renderer falls back to its own", () => {
		expect(distinctIdBootstrapScript()).toBe("");
	});

	it("escapes the value instead of concatenating it into the script", async () => {
		await resolveAnalyticsDistinctId('id";alert(1);//');
		expect(distinctIdBootstrapScript()).toBe('window.__DEV3_DISTINCT_ID__="id\\";alert(1);//";');
	});
});
