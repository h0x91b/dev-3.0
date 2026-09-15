/** Small arg-building helpers shared across adapters. */
import type { PaneInputStage } from "../pane-input";
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

/** The active third-party backend's routing args (shell-quoted), e.g. Codex's
 *  `-c model_provider="amazon-bedrock-runtime"`. Empty for the native default. */
export function providerArgs(options?: AdapterLaunchOptions): string[] {
	return (options?.providerArgs ?? []).map(quoteIfUnsafe);
}

/**
 * Gap between the interrupt and the typed command, so the CLI has redrawn its prompt
 * before the slash command arrives; and between the command and its Enter, so the
 * input layer sees a discrete submit rather than one paste with a newline in it.
 */
export const EXIT_PROGRAM_INTERRUPT_GAP_MS = 500;
export const EXIT_PROGRAM_SUBMIT_GAP_MS = 800;

/**
 * The quit sequence every slash-command CLI shares: Ctrl-C first, because a CLI that
 * is mid-turn (still generating, or blocked in the very `dev3 task move` that was just
 * approved) queues typed text instead of running it, and an idle one only prints a
 * "press again to exit" hint; then the CLI's own quit command, then Enter.
 */
export function slashExitProgram(command: "/exit" | "/quit"): readonly PaneInputStage[] {
	return [
		{ steps: [{ kind: "key", key: "ctrl-c" }] },
		{ delayBeforeMs: EXIT_PROGRAM_INTERRUPT_GAP_MS, steps: [{ kind: "text", text: command }] },
		{ delayBeforeMs: EXIT_PROGRAM_SUBMIT_GAP_MS, steps: [{ kind: "key", key: "enter" }] },
	];
}
