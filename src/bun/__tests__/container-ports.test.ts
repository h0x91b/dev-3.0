import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	runProbeText: vi.fn(async (_cmd: string[], _timeoutMs: number) => ""),
	realpathSync: vi.fn((path: string) => path),
}));

vi.mock("../probe-spawn", () => ({ runProbeText: mocks.runProbeText }));
vi.mock("node:fs", () => ({ realpathSync: mocks.realpathSync }));

import { findWorktreeContainerPorts, parseWorktreeContainerPorts } from "../container-ports";

describe("parseWorktreeContainerPorts", () => {
	const output = [
		"/wt\t0.0.0.0:17501->8000/tcp, [::]:17501->8000/tcp",
		"/wt/infra\t127.0.0.1:17502-17503->9000-9001/tcp",
		"/wt-other\t0.0.0.0:17600->8000/tcp",
		"\t0.0.0.0:6379->6379/tcp",
		"/wt\t6379/tcp",
		"",
	].join("\n");

	it("keeps ports of compose projects inside the worktree, including ranges", () => {
		expect([...parseWorktreeContainerPorts(output, ["/wt/"])].sort()).toEqual([17501, 17502, 17503]);
	});

	it("ignores a sibling path, an unlabelled container and an unpublished port", () => {
		expect(parseWorktreeContainerPorts(output, ["/wt-other"])).toEqual(new Set([17600]));
		expect(parseWorktreeContainerPorts("", ["/wt"]).size).toBe(0);
	});
});

describe("findWorktreeContainerPorts", () => {
	beforeEach(() => vi.clearAllMocks());

	it("asks docker for each container's compose working dir and published ports", async () => {
		mocks.runProbeText.mockResolvedValue("/wt\t0.0.0.0:17501->8000/tcp\n");

		expect(await findWorktreeContainerPorts("/wt")).toEqual(new Set([17501]));
		expect(mocks.runProbeText).toHaveBeenCalledWith(
			["docker", "ps", "--format", '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}'],
			expect.any(Number),
		);
	});

	it("matches a compose label recorded under the worktree's resolved path", async () => {
		mocks.realpathSync.mockReturnValue("/private/tmp/wt");
		mocks.runProbeText.mockResolvedValue("/private/tmp/wt\t0.0.0.0:17501->8000/tcp\n");

		expect(await findWorktreeContainerPorts("/tmp/wt")).toEqual(new Set([17501]));
	});

	it("is empty when docker is missing or fails", async () => {
		mocks.runProbeText.mockResolvedValue("");

		expect((await findWorktreeContainerPorts("/wt")).size).toBe(0);
	});
});
