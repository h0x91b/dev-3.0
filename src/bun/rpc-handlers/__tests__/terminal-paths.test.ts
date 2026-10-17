import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "dev3-terminal-paths-"));
const worktree = join(tmp, "worktree");
const projectDir = join(tmp, "project");

vi.mock("../../data", () => ({
	getProject: vi.fn(async (projectId: string) => {
		if (projectId !== "proj-1") throw new Error("unknown project");
		return { id: "proj-1", kind: "git", path: projectDir };
	}),
	getTask: vi.fn(async (_project: unknown, taskId: string) => {
		if (taskId !== "task-1") throw new Error("unknown task");
		return { id: "task-1", worktreePath: worktree };
	}),
	// The whole temp dir is a registered project so preview/open scope checks
	// (home dir + project roots) pass for the fixtures created below.
	// The checkout itself is a second root outside the temp dir, where a missing
	// file reaches the stat instead of failing the temp dir's symlink check.
	loadProjects: vi.fn(async () => [{ id: "proj-1", kind: "git", path: tmp }, { id: "proj-2", kind: "git", path: process.cwd() }]),
}));

vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electrobun-platform", () => ({
	Utils: { openPath: vi.fn() },
}));
vi.mock("../../spawn", () => ({
	spawn: vi.fn(),
}));

// The suffix fallback indexes a base with `git ls-files`; the fixtures below are
// plain temp dirs, so the listing is served from this fake instead of git.
const gitFiles: Record<string, string[]> = {};
const runGit = vi.fn(async (_cmd: string[], cwd: string) => {
	const files = gitFiles[cwd];
	if (!files) return { ok: false, stdout: "", stderr: "not a git repository" };
	return { ok: true, stdout: files.join("\0"), stderr: "" };
});
vi.mock("../../git", () => ({ run: (...args: unknown[]) => runGit(...(args as [string[], string])) }));

const wsl = vi.hoisted(() => ({ isWslHost: vi.fn(() => false), openOnWindowsHost: vi.fn(async (_path: string) => {}) }));
vi.mock("../../wsl-host", () => wsl);

import { isUnder, terminalPathHandlers as appHandlers } from "../terminal-paths";
import { resolveFileLinkPath } from "../../file-links";

beforeAll(() => {
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(join(worktree, "docs", "components"), { recursive: true });
	mkdirSync(join(worktree, "a"), { recursive: true });
	mkdirSync(join(worktree, "b"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(worktree, "src", "index.ts"), "export {};\n");
	writeFileSync(join(worktree, "docs", "architecture.md"), "# arch\n");
	writeFileSync(join(worktree, "docs", "components", "scout.md"), "# scout\n");
	writeFileSync(join(worktree, "a", "dup.md"), "a\n");
	writeFileSync(join(worktree, "b", "dup.md"), "b\n");
	writeFileSync(join(projectDir, "readme.md"), "# hi\n");
	writeFileSync(join(tmp, "notes.txt"), "hello\n");
	gitFiles[worktree] = [
		"src/index.ts",
		"docs/architecture.md",
		"docs/components/scout.md",
		"a/dup.md",
		"b/dup.md",
	];
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("resolveTerminalPaths", () => {
	it("resolves absolute paths without any project context", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			paths: [join(tmp, "notes.txt"), "/definitely/not/here.txt"],
		});
		expect(resolved[join(tmp, "notes.txt")]).toEqual({
			path: join(tmp, "notes.txt"),
			kind: "file",
		});
		expect(resolved["/definitely/not/here.txt"]).toBeNull();
	});

	it("resolves relative paths against the task worktree first, then the project dir", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			taskId: "task-1",
			projectId: "proj-1",
			paths: ["src/index.ts", "readme.md", "missing.md", "src"],
		});
		expect(resolved["src/index.ts"]).toEqual({
			path: join(worktree, "src", "index.ts"),
			kind: "file",
		});
		expect(resolved["readme.md"]).toEqual({
			path: join(projectDir, "readme.md"),
			kind: "file",
		});
		expect(resolved["missing.md"]).toBeNull();
		expect(resolved["src"]).toEqual({ path: join(worktree, "src"), kind: "directory" });
	});

	it("keeps the project base when the task id is not a real task (project terminal)", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			taskId: "project-session-key",
			projectId: "proj-1",
			paths: ["readme.md"],
		});
		expect(resolved["readme.md"]).toEqual({
			path: join(projectDir, "readme.md"),
			kind: "file",
		});
	});

	it("expands ~ against the home directory", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({ paths: ["~"] });
		expect(resolved["~"]).toEqual({ path: homedir(), kind: "directory" });
	});

	it("does not resolve paths outside the home directory and project roots", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			taskId: "task-1",
			projectId: "proj-1",
			// /etc/hosts exists everywhere, so null proves the scope gate rejected
			// it rather than stat() failing. `..` escapes the base the same way.
			paths: ["/etc/hosts", `${"../".repeat(12)}etc/hosts`],
		});
		expect(resolved["/etc/hosts"]).toBeNull();
		expect(resolved[`${"../".repeat(12)}etc/hosts`]).toBeNull();
	});

	// The gate builds a "/"-separated prefix, so on Windows nothing is ever under
	// any root and the temp allowance is inert there — the same way the home and
	// project roots are. See decisions/2026/09/16/terminal-links-allow-temp-dirs.md.
	it.skipIf(process.platform === "win32")(
		"resolves absolute paths under the OS temp directories, where agents park scratch files",
		async () => {
		// Not registered as a project and not under $HOME: only the temp-dir
		// allowance can make these resolve.
		const scratch = mkdtempSync(join(tmpdir(), "dev3-terminal-paths-scratch-"));
		const inTmpdir = join(scratch, "rebuilt-1-cropped.png");
		writeFileSync(inTmpdir, "png\n");
		// On macOS `os.tmpdir()` is `/var/folders/…` whose real path is
		// `/private/var/folders/…`; agents print both spellings of the same file.
		const viaRealPath = join(realpathSync(scratch), "rebuilt-1-cropped.png");
		const literalTmp = `/tmp/dev3-terminal-paths-${process.pid}.png`;
		writeFileSync(literalTmp, "png\n");
		try {
			const { resolved } = await appHandlers.resolveTerminalPaths({
				taskId: "task-1",
				projectId: "proj-1",
				paths: [inTmpdir, viaRealPath, literalTmp],
			});
			expect(resolved[inTmpdir]).toEqual({ path: inTmpdir, kind: "file" });
			expect(resolved[viaRealPath]).toEqual({ path: viaRealPath, kind: "file" });
			expect(resolved[literalTmp]).toEqual({ path: literalTmp, kind: "file" });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(literalTmp, { force: true });
		}
		},
	);

	// The temp dirs are world-writable, so this is the one place the string-prefix
	// gate is not enough: unfollowed, a planted link hands out a file no root covers.
	it.skipIf(process.platform === "win32")("refuses a temp-dir symlink pointing outside every allowed root", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "dev3-terminal-paths-escape-"));
		const escape = join(scratch, "screenshot.png");
		symlinkSync("/etc/hosts", escape);
		const inward = join(scratch, "notes-link.txt");
		symlinkSync(join(tmp, "notes.txt"), inward);
		try {
			const { resolved } = await appHandlers.resolveTerminalPaths({
				taskId: "task-1",
				projectId: "proj-1",
				paths: [escape, inward],
			});
			expect(resolved[escape]).toBeNull();
			expect(await appHandlers.readFilePreview({ path: escape })).toEqual({ kind: "not-found" });
			await expect(appHandlers.openTerminalPath({ path: escape, mode: "system" })).rejects.toThrow(
				/outside the allowed directories/,
			);
			// A link whose target is itself in scope still resolves — the check
			// follows the link, it does not ban links.
			expect(resolved[inward]).toEqual({ path: inward, kind: "file" });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("resolves a bare filename to the one nested file whose path ends with it", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			taskId: "task-1",
			projectId: "proj-1",
			paths: ["architecture.md", "components/scout.md"],
		});
		expect(resolved["architecture.md"]).toEqual({
			path: join(worktree, "docs", "architecture.md"),
			kind: "file",
		});
		expect(resolved["components/scout.md"]).toEqual({
			path: join(worktree, "docs", "components", "scout.md"),
			kind: "file",
		});
	});

	it("leaves an ambiguous suffix unresolved rather than guessing a file", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({
			taskId: "task-1",
			projectId: "proj-1",
			// dup.md exists twice; "cout.md" is a suffix but not at a segment boundary.
			paths: ["dup.md", "cout.md", "./architecture.md", "../docs/architecture.md"],
		});
		expect(resolved["dup.md"]).toBeNull();
		expect(resolved["cout.md"]).toBeNull();
		expect(resolved["./architecture.md"]).toBeNull();
		expect(resolved["../docs/architecture.md"]).toBeNull();
	});

	it("reuses the file index across calls instead of listing per candidate", async () => {
		// Warm, then assert the second call adds no listing of its own.
		await appHandlers.resolveTerminalPaths({ taskId: "task-1", projectId: "proj-1", paths: ["architecture.md"] });
		const before = runGit.mock.calls.length;
		await appHandlers.resolveTerminalPaths({
			taskId: "task-1",
			projectId: "proj-1",
			paths: ["architecture.md", "components/scout.md", "nowhere.md"],
		});
		expect(runGit.mock.calls.length).toBe(before);
	});

	it("relative paths resolve to null without a project context", async () => {
		const { resolved } = await appHandlers.resolveTerminalPaths({ paths: ["src/index.ts"] });
		expect(resolved["src/index.ts"]).toBeNull();
	});
});

describe("readFilePreview", () => {
	it("returns text content for small text files", async () => {
		const result = await appHandlers.readFilePreview({ path: join(tmp, "notes.txt") });
		expect(result).toEqual({ kind: "text", content: "hello\n", truncated: false, size: 6 });
	});

	it("classifies directories, missing paths and binary files", async () => {
		expect(await appHandlers.readFilePreview({ path: worktree })).toEqual({ kind: "directory" });
		expect(await appHandlers.readFilePreview({ path: join(tmp, "nope.txt") })).toEqual({
			kind: "not-found",
		});
		const binPath = join(tmp, "blob.bin");
		writeFileSync(binPath, Buffer.from([0x89, 0x00, 0x01, 0x02]));
		expect(await appHandlers.readFilePreview({ path: binPath })).toEqual({
			kind: "binary",
			size: 4,
		});
	});

	it("rejects relative paths", async () => {
		expect(await appHandlers.readFilePreview({ path: "relative/path.txt" })).toEqual({
			kind: "not-found",
		});
	});

	it("refuses paths outside the home dir and registered projects", async () => {
		expect(await appHandlers.readFilePreview({ path: "/etc/hosts" })).toEqual({
			kind: "not-found",
		});
		await expect(
			appHandlers.openTerminalPath({ path: "/etc/hosts", mode: "system" }),
		).rejects.toThrow(/outside the allowed/);
	});

	it("returns a data URL for images", async () => {
		const pngPath = join(tmp, "dot.png");
		// 1x1 transparent PNG
		writeFileSync(
			pngPath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const result = await appHandlers.readFilePreview({ path: pngPath });
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		}
	});
});

describe("createFileLink", () => {
	it("gives a page below a project root its folder, so its relative assets resolve", async () => {
		mkdirSync(join(worktree, "docs", "report", "assets"), { recursive: true });
		writeFileSync(join(worktree, "docs", "report", "index.html"), "<link rel=stylesheet href=assets/a.css>");
		writeFileSync(join(worktree, "docs", "report", "assets", "a.css"), "body{}");
		const { viewUrl, downloadUrl } = await appHandlers.createFileLink({ path: join(worktree, "docs", "report", "index.html") });
		expect(viewUrl).toMatch(/^\/file\/[A-Za-z0-9_-]{32}\/index\.html$/);
		expect(downloadUrl).toBe(`${viewUrl}?download=1`);
		expect(resolveFileLinkPath(viewUrl.replace(/index\.html$/, "assets/a.css"))).toBe(realpathSync(join(worktree, "docs", "report", "assets", "a.css")));
		expect(resolveFileLinkPath(viewUrl.replace(/index\.html$/, "..%2Farchitecture.md"))).toBeNull();
	});

	it("links a non-page as its one file, even inside a project", async () => {
		const { viewUrl } = await appHandlers.createFileLink({ path: join(worktree, "docs", "architecture.md") });
		expect(resolveFileLinkPath(viewUrl)).toBe(realpathSync(join(worktree, "docs", "architecture.md")));
		expect(resolveFileLinkPath(viewUrl.replace(/architecture\.md$/, "components/scout.md"))).toBeNull();
	});

	it("never gives a page at a checkout or project root the whole repository", async () => {
		mkdirSync(join(worktree, ".git"), { recursive: true });
		writeFileSync(join(worktree, "index.html"), "<p>root page</p>");
		writeFileSync(join(tmp, "root.html"), "<p>project root page</p>");
		try {
			for (const page of [join(worktree, "index.html"), join(tmp, "root.html")]) {
				const { viewUrl } = await appHandlers.createFileLink({ path: page });
				expect(resolveFileLinkPath(viewUrl)).toBe(realpathSync(page));
				expect(resolveFileLinkPath(viewUrl.replace(/[^/]+$/, "notes.txt"))).toBeNull();
			}
		} finally {
			rmSync(join(worktree, ".git"), { recursive: true, force: true });
		}
	});

	it("covers only the one file outside any project", async () => {
		const loose = join(tmpdir(), `dev3-file-link-${process.pid}.html`);
		writeFileSync(loose, "<p>loose</p>");
		try {
			const { viewUrl } = await appHandlers.createFileLink({ path: loose });
			expect(resolveFileLinkPath(viewUrl)).toBe(realpathSync(loose));
			expect(resolveFileLinkPath(viewUrl.replace(/[^/]+$/, "other.txt"))).toBeNull();
		} finally {
			rmSync(loose, { force: true });
		}
	});

	it("refuses paths the preview could not show", async () => {
		await expect(appHandlers.createFileLink({ path: "/etc/hosts" })).rejects.toThrow("outside the allowed");
		await expect(appHandlers.createFileLink({ path: join(process.cwd(), `dev3-missing-${process.pid}.txt`) })).rejects.toThrow("File not found");
		await expect(appHandlers.createFileLink({ path: worktree })).rejects.toThrow("Not a file");
	});
});

describe("isUnder", () => {
	it("matches below a root with the host's separator, Windows included", () => {
		expect(isUnder("C:\\Users\\me\\wt\\a.png", "C:\\Users\\me", "\\")).toBe(true);
		expect(isUnder("C:\\Users\\meow\\a.png", "C:\\Users\\me", "\\")).toBe(false);
		expect(isUnder("/home/me/wt/a.png", "/home/me", "/")).toBe(true);
		expect(isUnder("/home/meow/a.png", "/home/me", "/")).toBe(false);
	});
});

describe("openFileOnWindowsHost", () => {
	it("is refused off WSL and gated like the preview on WSL", async () => {
		wsl.isWslHost.mockReturnValue(false);
		expect(await appHandlers.getWindowsHostOpen()).toEqual({ available: false });
		await expect(appHandlers.openFileOnWindowsHost({ path: join(tmp, "notes.txt") })).rejects.toThrow("Not running under WSL");

		wsl.isWslHost.mockReturnValue(true);
		expect(await appHandlers.getWindowsHostOpen()).toEqual({ available: true });
		await expect(appHandlers.openFileOnWindowsHost({ path: "/etc/hosts" })).rejects.toThrow("outside the allowed");
		expect(wsl.openOnWindowsHost).not.toHaveBeenCalled();
		await appHandlers.openFileOnWindowsHost({ path: join(tmp, "notes.txt") });
		expect(wsl.openOnWindowsHost).toHaveBeenCalledWith(join(tmp, "notes.txt"));
	});

	it("refuses scripts and programs, which Windows' default action would run", async () => {
		wsl.isWslHost.mockReturnValue(true);
		wsl.openOnWindowsHost.mockClear();
		await expect(appHandlers.openFileOnWindowsHost({ path: join(worktree, "src", "index.ts") })).rejects.toThrow("not opened on Windows");
		writeFileSync(join(tmp, "build.js"), "1");
		await expect(appHandlers.openFileOnWindowsHost({ path: join(tmp, "build.js") })).rejects.toThrow("not opened on Windows");
		expect(wsl.openOnWindowsHost).not.toHaveBeenCalled();
	});
});
