import posthog from "posthog-js";

const apiKey = import.meta.env.VITE_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_POSTHOG_HOST;

if ((!apiKey || !apiHost) && import.meta.env.DEV) {
	const variableName = !apiKey ? "VITE_POSTHOG_KEY" : "VITE_POSTHOG_HOST";
	throw new Error(
		`${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`,
	);
}

// The flag APIs are exposed next to capture so feature-flags.ts can refresh and
// read flags; the rest of the posthog surface stays out of reach. With no key
// configured the no-op client reports every flag as unset, which lands the app
// on the shipped defaults in src/shared/feature-flags.ts.
type PostHogClient = Pick<
	typeof posthog,
	"capture" | "getFeatureFlag" | "onFeatureFlags" | "reloadFeatureFlags"
>;

const client: PostHogClient = apiKey && apiHost
	? posthog.init(apiKey, {
		api_host: apiHost,
		defaults: "2026-05-30",
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
	};

export default client;
