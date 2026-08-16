import posthog from "posthog-js";
import { telemetryEnabled } from "./telemetry";

// VITE_TELEMETRY=off outranks a configured key: the build asked for no
// telemetry, so a missing key is not a misconfiguration worth shouting about.
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
// read flags; the rest of the posthog surface stays out of reach. With no key
// configured — or telemetry off — the no-op client reports every flag as unset,
// which lands the app on the shipped defaults in src/shared/feature-flags.ts.
type PostHogClient = Pick<
	typeof posthog,
	"capture" | "getFeatureFlag" | "onFeatureFlags" | "reloadFeatureFlags" | "get_distinct_id"
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
		capture_exceptions: {
			capture_unhandled_errors: true,
			capture_unhandled_rejections: true,
			capture_console_errors: false,
		},
	})
	: {
		capture: () => undefined,
		getFeatureFlag: () => undefined,
		onFeatureFlags: () => () => undefined,
		reloadFeatureFlags: () => undefined,
		get_distinct_id: () => "",
	};

export default client;
