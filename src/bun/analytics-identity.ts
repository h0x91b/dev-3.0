/**
 * The install-wide PostHog distinct id.
 *
 * posthog-js mints an anonymous id per renderer and keeps it in that renderer's
 * localStorage, so the desktop window and a remote browser end up as two
 * different persons of the same machine — a percentage rollout would bucket them
 * independently. bun owns one id instead and hands it to every renderer.
 *
 * See decisions/2026/08/08/first-posthog-feature-flag.md.
 */
import { randomUUID } from "node:crypto";
import { loadSettings, loadSettingsSync, saveSettings } from "./settings";

/** Read without minting: callers that only render the HTML shell. */
export function analyticsDistinctIdSync(): string | null {
	return loadSettingsSync().analyticsDistinctId ?? null;
}

/**
 * Return the stored id, adopting `seed` if there is none yet.
 *
 * Seeding matters for existing installs: the desktop renderer already has a
 * posthog-js id with history behind it, so taking that one over minting a fresh
 * one keeps the person intact instead of splitting it in two.
 */
export async function resolveAnalyticsDistinctId(seed?: string): Promise<string> {
	const settings = await loadSettings();
	const stored = settings.analyticsDistinctId;
	if (stored) return stored;

	const distinctId = seed?.trim() || randomUUID();
	await saveSettings({ ...settings, analyticsDistinctId: distinctId });
	return distinctId;
}
