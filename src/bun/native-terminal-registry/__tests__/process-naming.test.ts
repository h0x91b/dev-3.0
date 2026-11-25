import { afterEach, describe, expect, it } from "vitest";
import {
	NATIVE_HOST_PROCESS_NAME,
	PANE_ID_ENV,
	TASK_SEQ_ENV,
	deriveNativeProcessIdentity,
	formatNativeHostProcessName,
	nativeHostProcessName,
	paneIdFromSessionId,
} from "../process-naming";

const TASK_SESSION = "dev3-task-11111111-2222-3333-4444-555555555555-pane-1";

describe("process-naming — pane id extraction", () => {
	it("reads the logical pane id off the last session-id segment only, null without one", () => {
		expect(paneIdFromSessionId(TASK_SESSION)).toBe("pane-1");
		expect(paneIdFromSessionId("dev3-task-abc-pane-12")).toBe("pane-12");
		{
			expect(paneIdFromSessionId("dev3-task-11111111-2222-3333-4444-555555555555")).toBeNull();
			expect(paneIdFromSessionId("probe-session")).toBeNull();
		}
		{
			expect(paneIdFromSessionId("dev3-pane-2-task-abc")).toBeNull();
		}
	});

});

describe("process-naming — identity derivation", () => {
	it("takes the task number (variant suffix included) from the launch env and the pane from the session id", () => {
		expect(deriveNativeProcessIdentity(TASK_SESSION, { [TASK_SEQ_ENV]: "1383" })).toEqual({
			seq: "1383",
			paneId: "pane-1",
		});
		{
			expect(deriveNativeProcessIdentity(TASK_SESSION, { [TASK_SEQ_ENV]: "1383-2" }).seq).toBe("1383-2");
		}
		{
			expect(deriveNativeProcessIdentity(TASK_SESSION, {}).seq).toBeNull();
			expect(deriveNativeProcessIdentity(TASK_SESSION).seq).toBeNull();
		}
	});

});

describe("process-naming — privacy", () => {
	// A process name is world-visible on a shared machine. Anything that is not a
	// bare task number must be dropped, not escaped or truncated.
	const rejected = [
		"1383; rm -rf /",
		"../../etc/passwd",
		"Fix the auth race condition",
		"/Users/arsenyp/.dev3.0/worktrees/x/worktree",
		"a1b2c3d4e5f6",
		"1383 pane:9",
		"",
		"   ",
		"1383\n1384",
		"-1",
		"1234567890",
		"1383-1234",
	];

	it("drops every non-numeric seq", () => {
		for (const value of rejected) {
			const identity = deriveNativeProcessIdentity(TASK_SESSION, { [TASK_SEQ_ENV]: value });
			expect(identity.seq, JSON.stringify(value)).toBeNull();
			expect(formatNativeHostProcessName(identity, TASK_SESSION)).toBe(`${NATIVE_HOST_PROCESS_NAME} pane:1`);
		}
	});

	it("never reads anything but the task number out of the launch env", () => {
		const name = nativeHostProcessName(TASK_SESSION, {
			[TASK_SEQ_ENV]: "1383",
			DEV3_TASK_TITLE: "Ship the secret feature",
			DEV3_WORKTREE_PATH: "/Users/arsenyp/.dev3.0/worktrees/slug/83bffcfd/worktree",
			DEV3_BRANCH_NAME: "feat/dev3-secret",
			ANTHROPIC_API_KEY: "sk-should-never-appear",
		});
		expect(name).toBe("dev3-terminal-host seq:1383 pane:1");
		for (const secret of ["secret", "worktrees", "sk-", "feat/"]) expect(name).not.toContain(secret);
	});
});

describe("process-naming — formatting", () => {
	it("names a pane by seq and pane, or by either alone", () => {
		expect(nativeHostProcessName(TASK_SESSION, { [TASK_SEQ_ENV]: "1383" })).toBe(
			"dev3-terminal-host seq:1383 pane:1",
		);
		{
			expect(nativeHostProcessName(TASK_SESSION)).toBe("dev3-terminal-host pane:1");
		}
		{
			expect(nativeHostProcessName("dev3-task-abc", { [TASK_SEQ_ENV]: "77" })).toBe("dev3-terminal-host seq:77");
		}
	});

	it("falls back to the session id and always leads with the carrier name", () => {
		expect(nativeHostProcessName("probe-session")).toBe("dev3-terminal-host probe-session");
		{
			const envs: Record<string, string>[] = [{}, { [TASK_SEQ_ENV]: "1" }, { [TASK_SEQ_ENV]: "nope" }];
			for (const env of envs) {
				expect(nativeHostProcessName(TASK_SESSION, env).startsWith(`${NATIVE_HOST_PROCESS_NAME} `)).toBe(true);
			}
		}
	});

});

describe("process-naming — environment isolation", () => {
	// DEV3_NATIVE_SESSION_* once leaked between suites because a module read
	// process.env at import time. This module must take env as an argument only.
	const ambient = [TASK_SEQ_ENV, PANE_ID_ENV];
	const saved = new Map(ambient.map((key) => [key, process.env[key]]));

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("ignores an ambient DEV3_TASK_SEQ or DEV3_PANE_ID in this process", () => {
		process.env[TASK_SEQ_ENV] = "999";
		expect(deriveNativeProcessIdentity(TASK_SESSION).seq).toBeNull();
		expect(nativeHostProcessName(TASK_SESSION)).toBe("dev3-terminal-host pane:1");
		{
			process.env[PANE_ID_ENV] = "pane-9";
			expect(deriveNativeProcessIdentity("probe-session").paneId).toBeNull();
		}
	});

	it("does not read process.env for the module's own source", async () => {
		const source = await Bun.file(new URL("../process-naming.ts", import.meta.url).pathname).text();
		expect(source).not.toContain("process.env");
	});
});
