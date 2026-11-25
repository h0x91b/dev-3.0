import { describe, expect, it } from "vitest";
import { pathBasename, posixProjectSlug, projectStorageKey, toPosixSeparators } from "../../shared/project-storage-key";
import { projectSlug as searchProjectSlug } from "../../shared/conversation-search-core";
import { listFilesystemRoots } from "../../shared/filesystem-roots";

/**
 * The POSIX half of this file guards a frozen on-disk contract (AGENTS.md): a
 * changed key renames every user's data directory out from under older installs.
 */
describe("projectStorageKey on POSIX", () => {
	it("keeps the frozen /a/b/c → a-b-c mapping", () => {
		expect(projectStorageKey("/Users/arsenyp/Desktop/my-repo", "darwin")).toBe("Users-arsenyp-Desktop-my-repo");
		expect(projectStorageKey("/home/ci/work/repo", "linux")).toBe("home-ci-work-repo");
	});

	it("preserves dots, spaces and dashes exactly as the frozen algorithm did", () => {
		expect(projectStorageKey("/Users/a/dev-3.0", "darwin")).toBe("Users-a-dev-3.0");
		expect(projectStorageKey("/Users/a/my repo", "darwin")).toBe("Users-a-my repo");
	});

	it("leaves a backslash alone — it is a legal POSIX file name character", () => {
		expect(projectStorageKey("/Users/a/we\\ird", "darwin")).toBe("Users-a-we\\ird");
	});

	it("matches the standalone frozen implementation for every shape", () => {
		for (const path of ["/a", "/a/b/c", "/a/b.c/d-e", "relative/no/lead", "/"]) {
			expect(projectStorageKey(path, "darwin")).toBe(posixProjectSlug(path));
		}
	});

	it("is the same key the conversation index derives", () => {
		expect(searchProjectSlug("/Users/a/repo")).toBe(projectStorageKey("/Users/a/repo"));
	});
});

describe("projectStorageKey on Windows", () => {
	it("turns a drive-qualified path into a legal directory name, with no character Win32 rejects", () => {
		expect(projectStorageKey("D:\\src\\dev-3.0", "win32")).toBe("D-src-dev-3.0");
		expect(projectStorageKey("C:/Users/user/repo", "win32")).toBe("C-Users-user-repo");
		const key = projectStorageKey("D:\\src\\dev-3.0", "win32");
		for (const illegal of ["<", ">", ":", '"', "/", "\\", "|", "?", "*"]) {
			expect(key, illegal).not.toContain(illegal);
		}
	});

	it("flattens UNC paths, illegal component characters, trailing dots, reserved device names and an empty path", () => {
		const cases: Array<[name: string, input: string, expected: string]> = [
			["UNC path without leading separators", "\\\\build-server\\share\\repo", "build-server-share-repo"],
			["characters illegal inside a component", 'C:\\src\\we"ird?name', "C-src-we_ird_name"],
			// Win32 would silently strip them on write.
			["trailing dot or space", "C:\\src\\repo. ", "C-src-repo"],
			["bare drive", "C:\\", "C"],
			["reserved device name, escaped so the directory can be created", "\\\\?\\nul", "_-nul"],
			["never an empty key", "", "_"],
		];
		for (const [name, input, expected] of cases) {
			expect(projectStorageKey(input, "win32"), name).toBe(expected);
		}
	});
});

describe("toPosixSeparators", () => {
	it("rewrites backslashes on Windows so one directory has one spelling, leaving POSIX paths (backslash included) untouched", () => {
		expect(toPosixSeparators("C:\\Users\\user\\.dev3.0\\worktrees", "win32")).toBe("C:/Users/user/.dev3.0/worktrees");
		expect(toPosixSeparators("/Users/a/we\\ird", "darwin")).toBe("/Users/a/we\\ird");
	});
});

describe("listFilesystemRoots", () => {
	it("offers every present drive so a repo off the home drive is reachable, omitting unmounted ones", () => {
		const present = new Set(["C:\\", "D:\\"]);
		expect(listFilesystemRoots("win32", (p) => present.has(p))).toEqual(["C:\\", "D:\\"]);
		expect(listFilesystemRoots("win32", (p) => p === "C:\\")).toEqual(["C:\\"]);
	});

	it("stays absent on POSIX, where the picker already offers /", () => {
		expect(listFilesystemRoots("darwin", () => true)).toBeUndefined();
		expect(listFilesystemRoots("linux", () => true)).toBeUndefined();
	});
});

describe("pathBasename", () => {
	it("names a project from a Windows path, or falls back to the input when there is no separator", () => {
		expect(pathBasename("D:\\src\\dev-3.0", "win32")).toBe("dev-3.0");
		expect(pathBasename("D:/src/dev-3.0", "win32")).toBe("dev-3.0");
		expect(pathBasename("D:\\src\\dev-3.0\\", "win32")).toBe("dev-3.0");
		expect(pathBasename("repo", "win32")).toBe("repo");
	});

	it("names a project from a POSIX path, keeping a backslash inside a file name", () => {
		expect(pathBasename("/Users/a/dev-3.0", "darwin")).toBe("dev-3.0");
		expect(pathBasename("/Users/a/repo/", "darwin")).toBe("repo");
		expect(pathBasename("/Users/a/we\\ird", "darwin")).toBe("we\\ird");
	});
});
