import { describe, expect, it } from "vitest";
import {
	advanceInterfaceOnboarding, initialInterfaceOnboarding, transitionInterfaceMode,
	ONBOARDING_ACTIVE_THRESHOLD_MS, ONBOARDING_LEASE_MS,
	type InterfaceOnboardingRequest, type InterfaceOnboardingState,
} from "../../shared/interface-onboarding";

const DAY = 86_400_000;
const poll = (clientId = "desktop", active = true, calm = true): InterfaceOnboardingRequest => ({ action: "poll", clientId, active, calm });
function run(state: InterfaceOnboardingState, request: InterfaceOnboardingRequest, now: number, runtime = "host") {
	return advanceInterfaceOnboarding(state, request, now, runtime);
}
function due() {
	const state = initialInterfaceOnboarding(true, true, 0);
	state.activeMs = ONBOARDING_ACTIVE_THRESHOLD_MS;
	state.dueAt = 0;
	return state;
}

describe("interface onboarding", () => {
	it("requires three hours of active use, independent of installation wall time", () => {
		let { state, response } = run(initialInterfaceOnboarding(true, true, 0), poll(), 20 * DAY);
		expect(response.prompt).toBeNull();
		for (let elapsed = 15_000; elapsed < ONBOARDING_ACTIVE_THRESHOLD_MS; elapsed += 15_000) {
			({ state, response } = run(state, poll(), 20 * DAY + elapsed));
			expect(response.prompt).toBeNull();
		}
		({ response } = run(state, poll(), 20 * DAY + ONBOARDING_ACTIVE_THRESHOLD_MS));
		expect(response.activeMs).toBe(ONBOARDING_ACTIVE_THRESHOLD_MS);
		expect(response.prompt).toBe("invite");
	});

	it("does not credit inactive windows, suspended clocks, or time while stopped", () => {
		let state = run(initialInterfaceOnboarding(true, true, 0), poll(), 0).state;
		state = run(state, poll("desktop", false), 15_000).state;
		state = run(state, poll(), 30_000).state;
		state = run(state, poll(), DAY).state;
		state = run(state, poll(), DAY + 15_000, "restarted").state;
		expect(state.activeMs).toBe(0);
	});

	it("counts overlapping desktop and remote intervals once", () => {
		let state = run(initialInterfaceOnboarding(true, true, 0), poll(), 0).state;
		state = run(state, poll("remote"), 5_000).state;
		state = run(state, poll(), 15_000).state;
		state = run(state, poll("remote"), 20_000).state;
		expect(state.activeMs).toBe(20_000);
	});

	it("persists progress, postponements, due time and leases across restart", () => {
		let state = run(due(), poll(), 0).state;
		state = run(state, { action: "postpone", clientId: "desktop" }, 500).state;
		state = JSON.parse(JSON.stringify(state));
		const result = run(state, poll(), 1_000, "next-host");
		expect(result.response).toMatchObject({ activeMs: ONBOARDING_ACTIVE_THRESHOLD_MS, postponements: 1, dueAt: DAY + 500, prompt: null });
	});

	it("postpones from each decision by 1, 3, 9, then 14 days indefinitely", () => {
		let state = due();
		let now = 0;
		for (const days of [1, 3, 9, 14, 14, 14]) {
			state = run(state, poll(), now).state;
			state = run(state, { action: "postpone", clientId: "desktop" }, now + 100).state;
			expect(state.dueAt).toBe(now + 100 + days * DAY);
			now = state.dueAt!;
		}
	});

	it("manual enable always begins a recurring 14-day schedule", () => {
		let state = initialInterfaceOnboarding(false, false, 0);
		state = run(state, { action: "enable", clientId: "desktop" }, 500).state;
		expect(state).toMatchObject({ source: "manual", dueAt: 14 * DAY + 500 });
		state = run(state, poll(), 14 * DAY + 500).state;
		state = run(state, { action: "postpone", clientId: "desktop" }, 14 * DAY + 600).state;
		expect(state.dueAt).toBe(28 * DAY + 600);
	});

	it("preserves existing full interface and existing simplified choice", () => {
		expect(run(initialInterfaceOnboarding(false, false, 0), poll(), 100 * DAY).response)
			.toMatchObject({ enabled: false, prompt: null, dueAt: null, lessonPending: false });
		expect(initialInterfaceOnboarding(true, false, 500)).toMatchObject({ enabled: true, source: "existing", dueAt: 14 * DAY + 500 });
	});

	it("makes due invitations eligible until an active calm poll", () => {
		let state = due();
		for (const request of [poll("desktop", false, true), poll("desktop", true, false)]) {
			const result = run(state, request, 100);
			state = result.state;
			expect(result.response.prompt).toBeNull();
		}
		expect(run(state, poll(), 200).response.prompt).toBe("invite");
	});

	it("grants one window a renewable lease and rejects stale decisions", () => {
		let state = run(due(), poll(), 0).state;
		let result = run(state, poll("remote"), 10_000);
		expect(result.response.prompt).toBeNull();
		state = run(result.state, poll("desktop", false, true), 20_000).state;
		expect(state.lease?.expiresAt).toBe(20_000 + ONBOARDING_LEASE_MS);
		state = run(state, poll("remote"), 20_000 + ONBOARDING_LEASE_MS).state;
		state = run(state, { action: "postpone", clientId: "desktop" }, 20_001 + ONBOARDING_LEASE_MS).state;
		expect(state.postponements).toBe(0);
		expect(state.lease?.clientId).toBe("remote");
	});

	it("stops invitations when disabled and teaches hiding controls only once", () => {
		let state = run(due(), { action: "disable", clientId: "desktop" }, 0).state;
		expect(state).toMatchObject({ enabled: false, dueAt: null, lessonPending: true });
		let result = run(state, poll(), 100);
		expect(result.response.prompt).toBe("lesson");
		state = run(result.state, { action: "acknowledge", clientId: "desktop" }, 200).state;
		transitionInterfaceMode(state, true, 300);
		transitionInterfaceMode(state, false, 400);
		expect(run(state, poll(), 500).response).toMatchObject({ prompt: null, lessonPending: false });
	});

	it("continues the accepted invitation directly into its one-time lesson", () => {
		const state = run(due(), poll(), 0).state;
		const result = run(state, { action: "disable", clientId: "desktop", calm: true }, 100);
		expect(result.response).toMatchObject({ enabled: false, prompt: "lesson", lessonPending: true });
		expect(result.state.lease?.clientId).toBe("desktop");
	});
});
