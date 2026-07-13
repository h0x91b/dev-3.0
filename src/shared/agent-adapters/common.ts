/** Small arg-building helpers shared across adapters. */
import type { AgentConfiguration } from "../types";
import { quoteIfUnsafe } from "./shell";
import type { AdapterLaunchOptions } from "./types";

/** `--model <name>` (quoted if unsafe) unless there is no model or a third-party
 *  provider owns the model selection (then it comes from injected env, not a flag). */
export function modelArgs(
	config: AgentConfiguration | undefined,
	options?: AdapterLaunchOptions,
): string[] {
	if (!config?.model || options?.skipModelForProvider) return [];
	// Model names may contain shell metacharacters (e.g. brackets in
	// `claude-opus-4-8[1m]`). Quote them so zsh doesn't glob-expand.
	return ["--model", quoteIfUnsafe(config.model)];
}
