/**
 * The pane the calling agent is sitting in, as its own shell was told. The native
 * backend exports DEV3_PANE_ID explicitly, while TMUX_PANE can leak into a native pane
 * when the app itself was started inside tmux — so DEV3_PANE_ID wins.
 */
export function selfPaneId(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.DEV3_PANE_ID?.trim() || env.TMUX_PANE?.trim() || null;
}
