/**
 * One push, every client the desktop host serves.
 *
 * The desktop process has two audiences at once: its own Electrobun windows and
 * whatever browser is attached over the remote-access server (a phone, a laptop
 * on the LAN, a tunnel). A hook that only broadcasts to windows leaves those
 * browsers rendering state the app already knows is stale — a dead terminal that
 * still looks alive, most visibly. `dev3 remote` never had the gap because it has
 * no windows to broadcast to, so every miss lived in the desktop entry alone.
 *
 * Every push in `src/bun/index.ts` goes through here, and
 * `__tests__/push-targets-wiring.test.ts` fails if a bare `broadcastToAllWindows`
 * call reappears there.
 */

import { broadcastToAllWindows, sendToFocusedWindow } from "./window-manager";
import { pushToBrowserClients } from "./remote-access-server";

/**
 * Events that are a SOUND, not state. Every window renders its own state, so
 * state goes to all of them — but two windows on one machine share one pair of
 * speakers, and a CLI/approval/merge completion broadcast that way chimes once
 * per window for a single finished task. These go to the focused window alone.
 *
 * Browser clients keep the full fan-out on purpose: a phone on the LAN is a
 * different device in a different room, and silencing it would break the
 * remote-only setup this push exists for.
 */
const SINGLE_WINDOW_PUSHES = new Set(["taskSound"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pushEverywhere(name: string, payload: any): void {
	if (SINGLE_WINDOW_PUSHES.has(name)) sendToFocusedWindow(name, payload);
	else broadcastToAllWindows(name, payload);
	pushToBrowserClients(name, payload);
}
