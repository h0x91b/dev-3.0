import { useEffect } from "react";
import { claimEscape } from "../escape-claims";

/**
 * Tell Keyboard Lock this layer closes on Escape, for as long as it is mounted and
 * `enabled`. Needed by any Esc handler that is not `useEscapeKey` or an overlay
 * layer — otherwise a fullscreen browser spends that Esc on leaving fullscreen.
 */
export function useEscapeClaim(enabled = true): void {
	useEffect(() => (enabled ? claimEscape() : undefined), [enabled]);
}
