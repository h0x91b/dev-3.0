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
import type { TelemetryOptOutSource } from "../shared/telemetry-consent";
import { resolveTelemetryOptOut } from "../shared/telemetry-consent";
import { loadSettings, loadSettingsSync, saveSettings } from "./settings";

/** Read without minting: callers that only render the HTML shell. */
export function analyticsDistinctIdSync(): string | null {
	return loadSettingsSync().analyticsDistinctId ?? null;
}

/**
 * The install's opt-out verdict, read fresh from the environment and settings.
 *
 * Synchronous because the HTML shell is assembled synchronously, and the shell is
 * the only place the answer can arrive early enough to matter.
 */
export function telemetryOptOutSync(): TelemetryOptOutSource | null {
	return resolveTelemetryOptOut(process.env, loadSettingsSync());
}

/**
 * Inline script handing a renderer the telemetry verdict and the install's id
 * before page scripts run.
 *
 * Both renderers need them from the same source: the desktop window gets this as a
 * webview preload, a remote browser as a tag in the served HTML. Without the id
 * posthog-js mints its own per renderer, so the id the Debug window showed was not
 * the one flags were evaluated against — and targeting it did nothing.
 *
 * An opted-out install ships the verdict and **no id at all**: the identifier is
 * only ever useful to a channel that is now switched off, and withholding it means
 * an unauthenticated browser hitting the remote server cannot read it either.
 */
export function telemetryBootstrapScript(): string {
	const optOut = telemetryOptOutSync();
	if (optOut) return `window.__DEV3_TELEMETRY_OPT_OUT__=${JSON.stringify(optOut)};`;

	// Empty until an id exists (first launch), which lands the renderer on its own
	// posthog-js id — the very id it then reports back as the seed.
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
