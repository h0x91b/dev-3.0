import posthog from "posthog-js";

const apiKey = import.meta.env.VITE_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_POSTHOG_HOST;

if ((!apiKey || !apiHost) && import.meta.env.DEV) {
	const variableName = !apiKey ? "VITE_POSTHOG_KEY" : "VITE_POSTHOG_HOST";
	throw new Error(
		`${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`,
	);
}

const client: Pick<typeof posthog, "capture"> = apiKey && apiHost
	? posthog.init(apiKey, {
		api_host: apiHost,
		defaults: "2026-05-30",
		capture_exceptions: {
			capture_unhandled_errors: true,
			capture_unhandled_rejections: true,
			capture_console_errors: false,
		},
	})
	: { capture: () => undefined };

export default client;
