import type { Handler } from "./shared";

export const secretCliHandlers: Record<string, Handler> = {
	"secret.run": async (params, ctx) => (await import("../rpc-handlers/secrets")).secretCliHandlers["secret.run"]!(params, ctx),
};
