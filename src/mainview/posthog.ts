import posthog from "posthog-js";
import { telemetryEnabled } from "./telemetry";

// An opt-out outranks a configured key: the install asked for no telemetry, so a
// missing key is not a misconfiguration worth shouting about.
const telemetry = telemetryEnabled();
const apiKey = import.meta.env.VITE_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_POSTHOG_HOST;

if (telemetry && (!apiKey || !apiHost) && import.meta.env.DEV) {
	const variableName = !apiKey ? "VITE_POSTHOG_KEY" : "VITE_POSTHOG_HOST";
	throw new Error(
		`${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`,
	);
}

// The flag APIs are exposed next to capture so feature-flags.ts can refresh and
// read flags; `opt_out_capturing` so the Settings toggle can silence a client that
// is already running. The rest of the posthog surface stays out of reach. With no
// key configured — or telemetry off — the no-op client reports every flag as unset,
// which lands the app on the shipped defaults in src/shared/feature-flags.ts.
type PostHogClient = Pick<
	typeof posthog,
	| "capture"
	| "getFeatureFlag"
	| "onFeatureFlags"
	| "reloadFeatureFlags"
	| "get_distinct_id"
	| "opt_out_capturing"
>;

// bun owns one distinct id per install and injects it into the HTML shell before
// this module runs, so the desktop window and a remote browser are one person
// rather than two. `bootstrap.distinctID` only applies when this renderer has no
// persisted identity of its own, which is exactly right: the desktop renderer
// keeps the id it already had, and bun seeds itself from that same id.
const injectedDistinctId = (window as unknown as { __DEV3_DISTINCT_ID__?: string }).__DEV3_DISTINCT_ID__;

const client: PostHogClient = telemetry && apiKey && apiHost
	? posthog.init(apiKey, {
		api_host: apiHost,
		defaults: "2026-05-30",
		...(injectedDistinctId
			? { bootstrap: { distinctID: injectedDistinctId, isIdentifiedID: false } }
			: {}),
		// Autocapture ships unmasked by default, and this app renders task titles
		// and project names as button text and in `title` / `aria-label`. Those are
		// a customer's repo names and an NDA'd codename; the README promises they
		// never leave the machine, and only these two options actually keep it.
		mask_all_text: true,
		mask_all_element_attributes: true,
		// Both are remote-configurable, so a dashboard toggle could otherwise turn
		// them on with no app update — in a window rendering source, diffs and live
		// terminal panes. Pinned in the client, where the server cannot reach.
		disable_session_recording: true,
		disable_surveys: true,
	})
	: {
		capture: () => undefined,
		getFeatureFlag: () => undefined,
		onFeatureFlags: () => () => undefined,
		reloadFeatureFlags: () => undefined,
		get_distinct_id: () => "",
		opt_out_capturing: () => undefined,
	};

export default client;
