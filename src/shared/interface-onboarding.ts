export const ONBOARDING_ACTIVE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
export const ONBOARDING_POLL_MS = 15_000;
export const ONBOARDING_MAX_GAP_MS = 30_000;
export const ONBOARDING_LEASE_MS = 45_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InterfaceOnboardingRequest {
	action: "poll" | "postpone" | "enable" | "disable" | "acknowledge";
	clientId: string;
	active?: boolean;
	calm?: boolean;
}

export interface InterfaceOnboardingResponse {
	enabled: boolean;
	source: "fresh" | "manual" | "existing";
	activeMs: number;
	postponements: number;
	dueAt: number | null;
	lessonPending: boolean;
	prompt: "invite" | "lesson" | null;
}

export interface InterfaceOnboardingState extends Omit<InterfaceOnboardingResponse, "prompt"> {
	version: 1;
	lessonSeen: boolean;
	lease: { clientId: string; expiresAt: number } | null;
	runtime: string;
	accountedAt: number;
	clients: Record<string, { at: number; active: boolean }>;
}

export function initialInterfaceOnboarding(enabled: boolean, fresh: boolean, now: number): InterfaceOnboardingState {
	return {
		version: 1, enabled, source: fresh ? "fresh" : "existing", activeMs: 0,
		postponements: 0, dueAt: enabled && !fresh ? now + 14 * DAY_MS : null,
		lessonPending: false, lessonSeen: false, lease: null,
		runtime: "", accountedAt: now, clients: {},
	};
}

export function transitionInterfaceMode(state: InterfaceOnboardingState, enabled: boolean, now: number): void {
	if (state.enabled === enabled) return;
	state.enabled = enabled;
	state.lease = null;
	state.clients = {};
	state.accountedAt = now;
	if (enabled) {
		state.source = "manual";
		state.postponements = 0;
		state.dueAt = now + 14 * DAY_MS;
		state.lessonPending = false;
	} else {
		state.dueAt = null;
		state.lessonPending = !state.lessonSeen;
	}
}

export function advanceInterfaceOnboarding(
	previous: InterfaceOnboardingState,
	request: InterfaceOnboardingRequest,
	now: number,
	runtime: string,
): { state: InterfaceOnboardingState; response: InterfaceOnboardingResponse } {
	const state = structuredClone(previous);
	if (state.runtime !== runtime) {
		state.runtime = runtime;
		state.clients = {};
		state.accountedAt = now;
	}
	if (state.lease && state.lease.expiresAt <= now) state.lease = null;
	const ownsLease = state.lease?.clientId === request.clientId;
	if (request.action === "enable" || request.action === "disable") {
		transitionInterfaceMode(state, request.action === "enable", now);
	} else if (request.action === "postpone" && ownsLease && state.enabled) {
		const days = state.source === "fresh" ? [1, 3, 9, 14][Math.min(state.postponements, 3)]! : 14;
		state.postponements += 1;
		state.dueAt = now + days * DAY_MS;
		state.lease = null;
	} else if (request.action === "acknowledge" && ownsLease && !state.enabled) {
		state.lessonSeen = true;
		state.lessonPending = false;
		state.lease = null;
	}
	if (request.action === "poll") {
		const elapsed = now - state.accountedAt;
		const activePreviously = Object.entries(state.clients).some(([id, client]) =>
			client.active && now - client.at <= ONBOARDING_MAX_GAP_MS && (id !== request.clientId || request.active === true));
		if (state.enabled && state.source === "fresh" && elapsed > 0 && elapsed <= ONBOARDING_MAX_GAP_MS && activePreviously) {
			state.activeMs = Math.min(ONBOARDING_ACTIVE_THRESHOLD_MS, state.activeMs + elapsed);
		}
		state.accountedAt = now;
		state.clients = Object.fromEntries(Object.entries(state.clients).filter(([, client]) => now - client.at <= ONBOARDING_MAX_GAP_MS));
		state.clients[request.clientId] = { at: now, active: request.active === true };
		if (state.enabled && state.source === "fresh" && state.dueAt === null && state.activeMs >= ONBOARDING_ACTIVE_THRESHOLD_MS) state.dueAt = now;
	}
	const eligible = state.enabled ? state.dueAt !== null && now >= state.dueAt : state.lessonPending;
	let prompt: InterfaceOnboardingResponse["prompt"] = null;
	const canOffer = request.action === "poll" || (request.action === "disable" && ownsLease);
	if (canOffer && eligible && (request.active || ownsLease) && request.calm && (!state.lease || state.lease.clientId === request.clientId)) {
		state.lease = { clientId: request.clientId, expiresAt: now + ONBOARDING_LEASE_MS };
		prompt = state.enabled ? "invite" : "lesson";
	}
	return { state, response: {
		enabled: state.enabled, source: state.source, activeMs: state.activeMs,
		postponements: state.postponements, dueAt: state.dueAt,
		lessonPending: state.lessonPending, prompt,
	} };
}
