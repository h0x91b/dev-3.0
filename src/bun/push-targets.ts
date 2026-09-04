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

import { broadcastToAllWindows } from "./window-manager";
import { pushToBrowserClients } from "./remote-access-server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pushEverywhere(name: string, payload: any): void {
	broadcastToAllWindows(name, payload);
	pushToBrowserClients(name, payload);
}
