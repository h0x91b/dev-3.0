import { describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { reclaimOutOfTreeState } from "../out-of-tree-state";

describe.skipIf(process.platform === "win32")("reclaimOutOfTreeState", () => {
	function bazelWorkspace(readmeWorkspace?: string): { worktree: string; outputBase: string } {
		const root = mkdtempSync(join(process.env.DEV3_TEST_ROOT!, "out-of-tree-"));
		const worktree = join(root, "worktree");
		const outputBase = join(root, "_bazel_user", "md5");
		const frozen = join(outputBase, "execroot", "_main", "bazel-out", "frozen");
		mkdirSync(worktree);
		mkdirSync(frozen, { recursive: true });
		writeFileSync(join(frozen, "Dump.class"), "");
		chmodSync(frozen, 0o555);
		writeFileSync(join(outputBase, "README"), `WORKSPACE: ${readmeWorkspace ?? worktree}\n`);
		symlinkSync(join(outputBase, "execroot", "_main", "bazel-out"), join(worktree, "bazel-out"));
		return { worktree, outputBase };
	}

	it("deletes the Bazel output base built for the worktree, read-only directories included", async () => {
		const { worktree, outputBase } = bazelWorkspace();
		reclaimOutOfTreeState(worktree);
		await vi.waitFor(() => expect(existsSync(outputBase)).toBe(false));
		expect(existsSync(worktree)).toBe(true);
	});

	it("keeps an output base built for another workspace", async () => {
		const { worktree, outputBase } = bazelWorkspace("/somewhere/else");
		reclaimOutOfTreeState(worktree);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(existsSync(join(outputBase, "README"))).toBe(true);
		chmodSync(join(outputBase, "execroot", "_main", "bazel-out", "frozen"), 0o755);
	});

	it("does nothing for a worktree with no out-of-tree state", () => {
		const root = mkdtempSync(join(process.env.DEV3_TEST_ROOT!, "out-of-tree-"));
		expect(() => reclaimOutOfTreeState(root)).not.toThrow();
		expect(() => reclaimOutOfTreeState(join(root, "missing"))).not.toThrow();
	});
});
