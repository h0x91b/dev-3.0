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
 * Inline script handing a renderer the install's id before page scripts run.
 *
 * Both renderers need it from the same source: the desktop window gets it as a
 * webview preload, a remote browser as a tag in the served HTML. Without it
 * posthog-js mints its own id per renderer, so the id the Debug window showed was
 * not the one flags were evaluated against — and targeting it did nothing.
 *
 * Empty until an id exists (first launch), which lands the renderer on its own
 * posthog-js id — the very id it then reports back as the seed.
 */
export function distinctIdBootstrapScript(): string {
	const id = analyticsDistinctIdSync();
	return id ? `window.__DEV3_DISTINCT_ID__=${JSON.stringify(id)};` : "";
}

/**
 * Return the stored id, adopting `seed` when there is none yet — or whenever the
 * caller is authoritative.
 *
 * Seeding matters for existing installs: the desktop renderer already has a
 * posthog-js id with history behind it, so taking that one over minting a fresh
 * one keeps the person intact instead of splitting it in two.
 *
 * Only the desktop renderer is authoritative, and it has to be: `bootstrap.distinctID`
 * loses to a renderer that already has its own persisted identity, so a browser with
 * history of its own keeps evaluating as itself. Letting whoever asked first own the
 * install forever meant one such browser could pin the stored id to an identity the
 * desktop window never evaluates as — flags then get targeted at nobody.
 */
export async function resolveAnalyticsDistinctId(
	seed?: string,
	opts: { authoritative?: boolean } = {},
): Promise<string> {
	const settings = await loadSettings();
	const stored = settings.analyticsDistinctId;
	const trimmed = seed?.trim();
	if (stored && !(opts.authoritative && trimmed && trimmed !== stored)) return stored;

	const distinctId = trimmed || randomUUID();
	await saveSettings({ ...settings, analyticsDistinctId: distinctId });
	return distinctId;
}
