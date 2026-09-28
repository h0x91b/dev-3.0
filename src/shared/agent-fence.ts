/**
 * The agent delivery fence: a tmux pane option the launch wrapper owns, telling every dev3
 * instance whether the agent it launched is still the program reading the pane.
 *
 *  - `open:<launchId>`            the wrapper's agent is running; dev3 may type
 *  - `closed:<launchId>:<code>`   the agent exited; nothing of dev3 may land here again
 *  - empty                        a pane without a fence (older wrapper, or none): legacy
 *
 * The value is checked INSIDE the one guarded tmux command that pastes, so it is atomic with
 * the write. See `decisions/2026/09/28/agent-delivery-fence.md`.
 */

/** Pane option holding the fence value. */
export const AGENT_FENCE_OPTION = "@dev3_agent_input";

/** Pane option holding the nonce of the one sentinel queued by the close that won. */
export const AGENT_FENCE_NONCE_OPTION = "@dev3_fence_nonce";

const LAUNCH_ID = /^[A-Za-z0-9-]{1,64}$/;
const NONCE = /^[0-9a-f]{16}$/;

export type AgentFenceState =
	| { readonly kind: "legacy" }
	| { readonly kind: "open"; readonly launchId: string }
	| { readonly kind: "closed"; readonly launchId: string; readonly exitCode: number }
	/** Something else wrote the option. Treated as closed: fail closed, never interpolated. */
	| { readonly kind: "malformed"; readonly raw: string };

export function isAgentFenceLaunchId(value: string): boolean {
	return LAUNCH_ID.test(value);
}

export function isAgentFenceNonce(value: string): boolean {
	return NONCE.test(value);
}

/** Parse the option exactly as tmux printed it. */
export function parseAgentFence(raw: string): AgentFenceState {
	if (raw === "") return { kind: "legacy" };
	const open = /^open:([A-Za-z0-9-]{1,64})$/.exec(raw);
	if (open) return { kind: "open", launchId: open[1]! };
	const closed = /^closed:([A-Za-z0-9-]{1,64}):(0|[1-9][0-9]{0,2})$/.exec(raw);
	if (closed && Number(closed[2]) <= 255) return { kind: "closed", launchId: closed[1]!, exitCode: Number(closed[2]) };
	return { kind: "malformed", raw: raw.slice(0, 80) };
}

/**
 * The value a pin carries into the guard: `""` for a legacy pane, `open:<id>` otherwise.
 * Only these two forms are ever interpolated into a tmux format.
 */
export function pinnableAgentFence(state: AgentFenceState): string | null {
	if (state.kind === "legacy") return "";
	if (state.kind === "open") return `open:${state.launchId}`;
	return null;
}

/** Whether `value` is a form {@link pinnableAgentFence} can produce. */
export function isPinnableAgentFence(value: string): boolean {
	return value === "" || /^open:[A-Za-z0-9-]{1,64}$/.test(value);
}

/**
 * The barrier a close queues behind every byte tmux accepted before it:
 * `\x1f dev3-fence:<16 hex> \x1f`. The wrapper starts no shell before reading it.
 */
export function agentFenceSentinel(nonce: string): string {
	if (!isAgentFenceNonce(nonce)) throw new Error(`unsafe agent fence nonce: ${nonce}`);
	return `\x1fdev3-fence:${nonce}\x1f`;
}
