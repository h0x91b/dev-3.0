// ── Agent-traffic feature flag ──
// Whether the agent-to-agent traffic readout and its log exist at all. Beta, off
// by default, lives in Settings → System → Advanced Experience next to BiDi.
//
// The value is a GlobalSettings field rather than localStorage so it follows the
// user into `dev3 remote` browser sessions, and it is mirrored here as a module
// flag because the consumers are spread across registries that are not React
// components (the keymap, the palette command list, the tip pool) as well as the
// header and the log itself.
//
// While it is off the feature leaves NO trace: no header control, no ⇧⌘M, no
// native-menu item, no palette command, no tip. A visible control that opens
// nothing is worse than a hidden feature.

export const AGENT_TRAFFIC_FLAG_CHANGED_EVENT = "agent-traffic-flag-changed" as const;

let enabled = false;

export function getAgentTrafficEnabled(): boolean {
	return enabled;
}

/** Called wherever globalSettings lands in the renderer (initial load + push). */
export function syncAgentTrafficFromGlobalSettings(settings: {
	experimentalAgentTraffic?: boolean;
}): void {
	const next = settings.experimentalAgentTraffic === true;
	if (next === enabled) return;
	enabled = next;
	window.dispatchEvent(
		new CustomEvent(AGENT_TRAFFIC_FLAG_CHANGED_EVENT, { detail: next }),
	);
}

/** Test-only override — production code changes the flag through settings. */
export function setAgentTrafficEnabledForTests(next: boolean): void {
	enabled = next;
}
