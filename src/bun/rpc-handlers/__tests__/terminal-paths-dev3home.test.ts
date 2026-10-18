import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// DEV3_HOME outside the home dir, the temp dirs and every project: /var/tmp is none of them.
const dev3Home = vi.hoisted(() => `/var/tmp/dev3-home-outside-${process.pid}`);
vi.mock("../../paths", () => ({ DEV3_HOME: dev3Home }));
vi.mock("../../data", () => ({ loadProjects: vi.fn(async () => []), getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("../shared", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../electrobun-platform", () => ({ Utils: { openPath: vi.fn() } }));
vi.mock("../../spawn", () => ({ spawn: vi.fn() }));
vi.mock("../../git", () => ({ run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })) }));
vi.mock("../../wsl-host", () => ({ isWslHost: () => false, openOnWindowsHost: vi.fn() }));

import { terminalPathHandlers } from "../terminal-paths";
import { resolveFileLinkPath } from "../../file-links";

const usable = process.platform !== "win32" && existsSync("/var/tmp");

afterAll(() => rmSync(dev3Home, { recursive: true, force: true }));

describe("createFileLink with DEV3_HOME outside the home directory", () => {
	it.runIf(usable)("still links dev3's own shared media, and nothing else out there", async () => {
		const clip = join(dev3Home, "worktrees", "proj", "shared-images", "shot.png");
		mkdirSync(join(clip, ".."), { recursive: true });
		writeFileSync(clip, "PNG");
		const { url } = await terminalPathHandlers.createFileLink({ path: clip });
		expect(resolveFileLinkPath(url)).toBe(realpathSync(clip));

		writeFileSync(join(dev3Home, "outside-worktrees.txt"), "x");
		await expect(terminalPathHandlers.createFileLink({ path: join(dev3Home, "outside-worktrees.txt") })).rejects.toThrow("outside the allowed");
	});
});
