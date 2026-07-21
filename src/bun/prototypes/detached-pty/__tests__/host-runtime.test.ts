import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHost } from "../host";

describe("detached host native-runtime boundary", () => {
	let root: string;
	let originalPlatform: PropertyDescriptor | undefined;
	let originalVersion: unknown;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-host-runtime-"));
		process.env.DEV3_PTY_PROTO_DIR = root;
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		originalVersion = (Bun as unknown as { version?: unknown }).version;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		(Bun as unknown as { version?: unknown }).version = originalVersion;
		delete process.env.DEV3_PTY_PROTO_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects an old packaged Windows Bun before spawning or creating native state", async () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		(Bun as unknown as { version?: unknown }).version = "1.3.13";
		const spawn = vi.spyOn(Bun, "spawn");

		await expect(runHost({ cmd: ["powershell.exe"] })).rejects.toThrow(
			"packaged Bun 1.3.13 lacks Windows ConPTY support",
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("turns a Bun.Terminal spawn failure into an actionable packaged-runtime error", async () => {
		(Bun as unknown as { version?: unknown }).version = "1.3.14";
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("terminal option is not supported on this platform");
		});

		await expect(runHost({ cmd: ["custom-shell"] })).rejects.toThrow(
			"packaged Bun 1.3.14 could not start custom-shell through Bun.Terminal",
		);
	});
});
