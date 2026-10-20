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

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;
