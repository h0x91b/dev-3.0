/**
 * VITE_TELEMETRY=off has to outrank a configured PostHog key — "no telemetry" is a
 * property of the build, not of whether someone remembered to leave the key out.
 * The no-op client must still answer the flag APIs so feature-flags.ts lands on
 * the shipped defaults instead of throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { posthogJs } = vi.hoisted(() => ({
	posthogJs: {
		init: vi.fn((_key: string, _config: Record<string, unknown>) => ({
			capture: vi.fn(),
			getFeatureFlag: vi.fn(() => true),
			onFeatureFlags: vi.fn(() => () => undefined),
			reloadFeatureFlags: vi.fn(),
			get_distinct_id: vi.fn(() => "real-id"),
		})),
	},
}));

vi.mock("posthog-js", () => ({ default: posthogJs }));
// test-setup.ts mocks this module globally; this suite exercises the real one.
vi.unmock("../posthog");

async function loadClient() {
	vi.resetModules();
	return (await import("../posthog")).default;
}

beforeEach(() => {
	posthogJs.init.mockClear();
	vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key");
	vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.test");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("posthog build-time telemetry gate", () => {
	it("initializes when VITE_TELEMETRY is unset — the default is on", async () => {
		const client = await loadClient();
		expect(posthogJs.init).toHaveBeenCalledWith(
			"phc_test_key",
			expect.objectContaining({ api_host: "https://posthog.test" }),
		);
		expect(client.getFeatureFlag("anything")).toBe(true);
	});

	it("initializes with VITE_TELEMETRY=on", async () => {
		vi.stubEnv("VITE_TELEMETRY", "on");
		await loadClient();
		expect(posthogJs.init).toHaveBeenCalledTimes(1);
	});

	it("does not initialize with VITE_TELEMETRY=off, key and host notwithstanding", async () => {
		vi.stubEnv("VITE_TELEMETRY", "off");
		const client = await loadClient();
		expect(posthogJs.init).not.toHaveBeenCalled();
		expect(client.capture("task_created")).toBeUndefined();
	});

	it.each(["OFF", "false", "0", "no"])("treats %j as off too", async (value) => {
		vi.stubEnv("VITE_TELEMETRY", value);
		await loadClient();
		expect(posthogJs.init).not.toHaveBeenCalled();
	});

	it("falls back to shipped feature-flag defaults when off", async () => {
		vi.stubEnv("VITE_TELEMETRY", "off");
		const client = await loadClient();
		expect(client.getFeatureFlag("any-flag")).toBeUndefined();
		expect(client.get_distinct_id()).toBe("");
		expect(client.onFeatureFlags(() => undefined)).toBeTypeOf("function");
	});

	it("does not initialize when the host injected an opt-out verdict", async () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "setting";
		try {
			await loadClient();
			expect(posthogJs.init).not.toHaveBeenCalled();
		} finally {
			delete window.__DEV3_TELEMETRY_OPT_OUT__;
		}
	});
});

/**
 * Autocapture ships unmasked and harvests `textContent`, `title` and `aria-label`
 * from clickable subtrees — which in this app are task titles and project names.
 * These two options are the only thing stopping that, so they get a guard rather
 * than a comment claiming they are set.
 */
describe("posthog autocapture masking", () => {
	it("masks element text and attributes", async () => {
		await loadClient();
		expect(posthogJs.init).toHaveBeenCalledWith(
			"phc_test_key",
			expect.objectContaining({
				mask_all_text: true,
				mask_all_element_attributes: true,
			}),
		);
	});

	// These are remote-configurable by default, so a dashboard toggle on the vendor's
	// side could switch them on with no app update. Pinned in the client instead.
	it("pins off every channel that would capture content we cannot mask", async () => {
		await loadClient();
		expect(posthogJs.init).toHaveBeenCalledWith(
			"phc_test_key",
			expect.objectContaining({
				disable_session_recording: true,
				disable_surveys: true,
			}),
		);
	});

	it("leaves exception capture to the server-side config instead of forcing it on", async () => {
		await loadClient();
		expect(posthogJs.init.mock.calls[0]?.[1]).not.toHaveProperty("capture_exceptions");
	});
});
