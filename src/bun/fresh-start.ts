/**
 * "Fresh start" mode — set by the local dev launch (`bun run dev` / `bun run start`)
 * via `DEV3_FRESH_START=1`.
 *
 * When on, the app deliberately IGNORES persisted UI state on launch:
 *   - window geometry / macOS fullscreen restore is skipped (open a default
 *     centered window instead), and
 *   - the last route restore is skipped (always land on the dashboard).
 *
 * It also stops PERSISTING that state, so a dev run never clobbers the shared
 * `~/.dev3.0/window-state.json` / `last-route.json` that the real (prod) install
 * restores from — both files live in the cross-install `~/.dev3.0` home.
 *
 * Rationale: restoring fullscreen + the last task on every `bun run dev` makes the
 * screen flicker/relocate constantly during development. Prod launches are
 * unaffected (the env var is only set by the dev scripts).
 */
export function isFreshStartMode(): boolean {
	return process.env.DEV3_FRESH_START === "1";
}
