import { createLogger } from "../logger";

export const log = createLogger("cli-socket");

/**
 * Loaded on demand, not at module load. The handler module reaches the renderer
 * bridge through `rpc-handlers/shared`, which pulls Electrobun in — and the suites
 * that import this file mock only the handler BARREL, so a static import here
 * kills them at collect time with an error from inside Electrobun.
 */
export async function conversationImport() {
	return (await import("../rpc-handlers/conversation-import-handlers")).conversationImportHandlers;
}

/** `signal` aborts when the CLI client's connection closes. */
export type Handler = (params: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Split one handler into `<method>` and `<method>AsSender`. `--as-sender` travels
 * only on the second name, so an app that predates external senders refuses it
 * with "Unknown method" instead of ignoring `asSender` — which would type the text
 * as the user and start a task without the approval dialog.
 */
export function withSenderVariant(method: string, handler: Handler): Record<string, Handler> {
	return {
		[method]: (params, ctx) => {
			if (params.asSender !== undefined) throw new Error(`asSender is only accepted by ${method}AsSender.`);
			return handler(params, ctx);
		},
		[`${method}AsSender`]: (params, ctx) => {
			if (typeof params.asSender !== "string") throw new Error("asSender is required.");
			return handler(params, ctx);
		},
	};
}
