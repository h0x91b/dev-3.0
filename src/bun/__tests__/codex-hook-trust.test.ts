import { describe, expect, it, vi } from "vitest";
import {
	buildCodexHooksConfigOverride,
	CODEX_DEV3_HOOK_COMMAND,
	CODEX_STATUS_HOOK_EVENTS,
} from "../../shared/agent-hooks";
import { prepareCodexWorktreeHookOverride } from "../codex-hook-trust";

function stream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

describe("prepareCodexWorktreeHookOverride", () => {
	it("adds session-scoped trust only for exact dev3 command hooks", async () => {
		const worktreePath = "/tmp/dev3-worktree";
		let input = "";
		const hooks = [
			...CODEX_STATUS_HOOK_EVENTS.map((eventName, index) => ({
				key: `/<session-flags>/config.toml:${eventName.toLowerCase()}:0:0`,
				eventName,
				handlerType: "command",
				command: CODEX_DEV3_HOOK_COMMAND,
				sourcePath: "/<session-flags>/config.toml",
				source: "sessionFlags",
				currentHash: `sha256:dev3-${index}`,
				trustStatus: "untrusted",
			})),
			{
				key: "/<session-flags>/config.toml:stop:1:0",
				eventName: "Stop",
				handlerType: "command",
				command: "curl https://example.invalid",
				sourcePath: "/<session-flags>/config.toml",
				source: "sessionFlags",
				currentHash: "sha256:foreign",
				trustStatus: "untrusted",
			},
			{
				key: "/Users/me/.codex/hooks.json:stop:0:0",
				eventName: "Stop",
				handlerType: "command",
				command: CODEX_DEV3_HOOK_COMMAND,
				sourcePath: "/Users/me/.codex/hooks.json",
				source: "user",
				currentHash: "sha256:other",
				trustStatus: "untrusted",
			},
		];
		const response = [
			JSON.stringify({ id: 0, result: { userAgent: "test" } }),
			JSON.stringify({ id: 41, result: { data: [{ cwd: worktreePath, hooks, warnings: [], errors: [] }] } }),
		].join("\n") + "\n";
		const spawnProcess = vi.fn(() => ({
			stdin: {
				write: vi.fn((chunk: string) => {
					input += chunk;
				}),
				end: vi.fn(),
			},
			stdout: stream(response),
			stderr: stream(""),
			exited: Promise.resolve(0),
			kill: vi.fn(),
		}));

		const override = await prepareCodexWorktreeHookOverride(worktreePath, spawnProcess as never, 1000);

		expect(override).toContain("SessionStart");
		expect(override).toContain("trusted_hash=\"sha256:dev3-0\"");
		expect(override).toContain("trusted_hash=\"sha256:dev3-5\"");
		expect(override).not.toContain("sha256:foreign");
		expect(override).not.toContain("sha256:other");
		expect(spawnProcess).toHaveBeenCalledWith(
			["codex", "app-server", "--stdio", "-c", buildCodexHooksConfigOverride()],
			expect.objectContaining({ cwd: worktreePath, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		);
		const messages = input.trim().split("\n").map((line) => JSON.parse(line));
		expect(messages[2]).toEqual({ method: "hooks/list", id: 41, params: { cwds: [worktreePath] } });
		expect(messages).toHaveLength(3);
	});

	it("returns the untrusted session override on Codex versions without hooks/list", async () => {
		let input = "";
		const spawnProcess = vi.fn(() => ({
			stdin: {
				write: vi.fn((chunk: string) => {
					input += chunk;
				}),
				end: vi.fn(),
			},
			stdout: stream(`${JSON.stringify({ id: 41, error: { code: -32601, message: "Method not found" } })}\n`),
			stderr: stream(""),
			exited: Promise.resolve(0),
			kill: vi.fn(),
		}));

		expect(await prepareCodexWorktreeHookOverride("/tmp/dev3-worktree", spawnProcess as never, 1000))
			.toBe(buildCodexHooksConfigOverride());
		expect(input).not.toContain("config/batchWrite");
	});
});
