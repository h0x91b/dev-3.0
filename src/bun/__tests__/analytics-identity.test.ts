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

import { analyticsDistinctIdSync, resolveAnalyticsDistinctId } from "../analytics-identity";

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

	it("reads without minting, so rendering the HTML shell cannot create an id", () => {
		expect(analyticsDistinctIdSync()).toBeNull();
		expect(store.settings.analyticsDistinctId).toBeUndefined();
	});

	it("exposes the stored id to the HTML shell once it exists", async () => {
		await resolveAnalyticsDistinctId("desktop-id");
		expect(analyticsDistinctIdSync()).toBe("desktop-id");
	});
});
