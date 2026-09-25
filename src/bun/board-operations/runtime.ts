import { getPushMessage } from "../rpc-handlers/shared-pure";
import type { BoardPorts } from "./types";

/**
 * Production ports. `getPushMessage()` already fans a push out to every window or
 * browser client and, for data events, to peer instances — so one call per applied
 * change is what keeps every client current. The lifecycle is imported lazily so
 * the operation modules, and anything importing this file, stay free of the
 * lifecycle/Electrobun import chain at load time.
 */
export const boardPorts: BoardPorts = {
	push: (name, payload) => getPushMessage()?.(name, payload),
	clearMergeNotification: async (taskId) => {
		const { clearMergeNotification } = await import("../lifecycle/activities");
		clearMergeNotification(taskId);
	},
};
