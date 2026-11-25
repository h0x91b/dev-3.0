import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, spawnSync } from "../spawn";
import { DEV3_HOME } from "../paths";
import { markTaskPreparationCancelled, withTaskPreparation } from "../preparation-runtime";

// The main process keeps its cwd inside the .app bundle (electrobun resolves the
// `views://` protocol relative to process.cwd()), so child processes must NOT
// inherit that bundle cwd — a brew upgrade can delete it from under us and every
// cwd-less spawn would ENOENT. spawn.ts pins cwd-less children to DEV3_HOME.
// See decision 109.
describe("spawn/spawnSync cwd defaulting", () => {
	afterEach(() => vi.restoreAllMocks());

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const Bun = globalThis.Bun as any;

	it("defaults child cwd to DEV3_HOME — none passed, explicitly undefined, or via spawnSync — and honours an explicit cwd", () => {
		const spy = vi.spyOn(Bun, "spawn");
		spawn(["true"]);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ cwd: DEV3_HOME });
		spawn(["true"], { cwd: "/some/worktree" });
		expect(spy.mock.calls[1][1]).toMatchObject({ cwd: "/some/worktree" });
		spawn(["true"], { cwd: undefined, stdout: "pipe" });
		expect(spy.mock.calls[2][1]).toMatchObject({ cwd: DEV3_HOME, stdout: "pipe" });
		const syncSpy = vi.spyOn(Bun, "spawnSync");
		spawnSync(["true"]);
		expect(syncSpy.mock.calls[0][1]).toMatchObject({ cwd: DEV3_HOME });
	});

	it("still merges process.env into the child env", () => {
		const spy = vi.spyOn(Bun, "spawn");
		spawn(["true"], { env: { FOO: "bar" } });
		const opts = spy.mock.calls[0][1] as { env: Record<string, string> };
		expect(opts.env.FOO).toBe("bar");
		expect(opts.env.PATH).toBe(process.env.PATH);
	});

	it("kills a child spawned after its preparation was cancelled", async () => {
		const kill = vi.fn();
		vi.spyOn(Bun, "spawn").mockReturnValue({
			pid: 321,
			exited: Promise.resolve(137),
			kill,
		});

		await withTaskPreparation("late-spawn", "test", async () => {
			markTaskPreparationCancelled("late-spawn");
			const proc = spawn(["git", "worktree", "add"]);
			await proc.exited;
		});

		expect(kill).toHaveBeenCalledWith(9);
	});
});
