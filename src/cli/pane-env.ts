/** The pane the calling agent is sitting in, as its own shell was told. */
export function selfPaneId(): string | null {
	// Native panes export DEV3_PANE_ID; tmux exports TMUX_PANE. Nothing is inferred
	// from the platform — whichever variable is present names the backend in play.
	const native = process.env.DEV3_PANE_ID?.trim();
	if (native) return native;
	const tmuxPane = process.env.TMUX_PANE?.trim();
	return tmuxPane || null;
}
