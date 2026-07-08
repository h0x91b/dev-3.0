import { resolve } from "node:path";
import {
	buildCodexHooksConfigOverride,
	CODEX_DEV3_HOOK_COMMAND,
	CODEX_STATUS_HOOK_EVENTS,
} from "../shared/agent-hooks";
import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("codex-hook-trust");
const HOOKS_LIST_REQUEST_ID = 41;
const DEFAULT_TIMEOUT_MS = 5_000;

type SpawnProcess = typeof spawn;

interface HookMetadata {
	key?: unknown;
	handlerType?: unknown;
	command?: unknown;
	source?: unknown;
	currentHash?: unknown;
}

/**
 * Build the session-level Codex config override that carries dev3's generated
 * worktree hooks and their exact trusted hashes. Nothing is persisted in the
 * user's global hooks file or config: both definitions and trust live only for
 * the Codex process dev3 is about to launch.
 */
export async function prepareCodexWorktreeHookOverride(
	worktreePath: string,
	spawnProcess: SpawnProcess = spawn,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const cwd = resolve(worktreePath);
	const eventsOverride = buildCodexHooksConfigOverride();
	let proc: ReturnType<SpawnProcess> | null = null;
	let stdin: import("bun").FileSink | null = null;
	let timeout: ReturnType<typeof setTimeout> | null = null;

	try {
		proc = spawnProcess(["codex", "app-server", "--stdio", "-c", eventsOverride], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		stdin = proc.stdin as unknown as import("bun").FileSink;
		stdin.write(`${JSON.stringify({ method: "initialize", id: 0, params: { clientInfo: { name: "dev3", title: "dev-3.0", version: "1" } } })}\n`);
		stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
		stdin.write(`${JSON.stringify({ method: "hooks/list", id: HOOKS_LIST_REQUEST_ID, params: { cwds: [cwd] } })}\n`);

		// Never copy stderr into logs: Codex diagnostics can contain account data.
		void new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text().catch(() => {});
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				proc?.kill();
				reject(new Error("Codex hook hash request timed out"));
			}, timeoutMs);
		});
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffered = "";

		while (true) {
			const chunk = await Promise.race([reader.read(), timeoutPromise]);
			buffered += chunk.value ? decoder.decode(chunk.value, { stream: !chunk.done }) : "";
			const lines = buffered.split("\n");
			buffered = chunk.done ? "" : lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				let message: {
					id?: number;
					result?: { data?: Array<{ cwd?: unknown; hooks?: HookMetadata[] }> };
					error?: unknown;
				};
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id !== HOOKS_LIST_REQUEST_ID) continue;
				if (message.error) return eventsOverride;

				const entry = message.result?.data?.find((candidate) => candidate.cwd === cwd);
				const matching = (entry?.hooks ?? []).filter((hook) =>
					hook.source === "sessionFlags"
					&& hook.handlerType === "command"
					&& hook.command === CODEX_DEV3_HOOK_COMMAND
					&& typeof hook.key === "string"
					&& typeof hook.currentHash === "string"
				);
				if (matching.length !== CODEX_STATUS_HOOK_EVENTS.length) return eventsOverride;

				const state = Object.fromEntries(matching.map((hook) => [
					hook.key as string,
					{ trusted_hash: hook.currentHash as string },
				]));
				return buildCodexHooksConfigOverride(state);
			}
			if (chunk.done) break;
		}
		return eventsOverride;
	} catch (error) {
		// Codex versions old enough to lack hooks/list also predate hash trust.
		// Passing the definitions alone preserves their supported hook events.
		log.warn("Could not resolve Codex hook hashes; using session definitions without trust state", {
			worktreePath: cwd,
			error: String(error),
		});
		return eventsOverride;
	} finally {
		if (timeout) clearTimeout(timeout);
		stdin?.end();
		proc?.kill();
	}
}
