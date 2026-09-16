/**
 * Which pane and which launch a lifecycle hook is reporting from.
 *
 * A hook process runs inside the agent's own pane and inherits its environment,
 * so both facts are already there — nothing is inferred and nothing is guessed.
 *
 * - The pane tells dev3 WHERE a receipt applies, so a ready main agent cannot
 *   vouch for a second pane still sitting in its trust dialog.
 * - The launch id is the generation token dev3 injected at spawn time
 *   (`DEV3_LAUNCH_ID`). A receipt naming a launch the app has since replaced is
 *   rejected, which is the difference between a real generation token and
 *   clearing a map — the old agent's slow hook would otherwise arrive
 *   afterwards and look new (h0x91b/dev-3.0#1785).
 */

export interface HookIdentity {
	paneId?: string;
	launchId?: string;
}

export function hookIdentity(env: NodeJS.ProcessEnv = process.env): HookIdentity {
	// Native panes export DEV3_PANE_ID; tmux exports TMUX_PANE. Nothing is inferred
	// from the platform — whichever variable is present names the backend in play.
	const paneId = env.DEV3_PANE_ID?.trim() || env.TMUX_PANE?.trim();
	const launchId = env.DEV3_LAUNCH_ID?.trim();
	return {
		...(paneId ? { paneId } : {}),
		...(launchId ? { launchId } : {}),
	};
}
