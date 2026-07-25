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
	it("turns a drive-qualified path into a legal directory name", () => {
		expect(projectStorageKey("D:\\src\\dev-3.0", "win32")).toBe("D-src-dev-3.0");
		expect(projectStorageKey("C:/Users/user/repo", "win32")).toBe("C-Users-user-repo");
	});

	it("produces a key with no character Win32 rejects", () => {
		const key = projectStorageKey("D:\\src\\dev-3.0", "win32");
		for (const illegal of ["<", ">", ":", '"', "/", "\\", "|", "?", "*"]) {
			expect(key).not.toContain(illegal);
		}
	});

	it("flattens a UNC path without leaving leading separators", () => {
		expect(projectStorageKey("\\\\build-server\\share\\repo", "win32")).toBe("build-server-share-repo");
	});

	it("replaces characters that are illegal inside a component", () => {
		expect(projectStorageKey('C:\\src\\we"ird?name', "win32")).toBe("C-src-we_ird_name");
	});

	it("drops a trailing dot or space, which Win32 would silently strip on write", () => {
		expect(projectStorageKey("C:\\src\\repo. ", "win32")).toBe("C-src-repo");
	});

	it("escapes a reserved device name so the directory can be created", () => {
		expect(projectStorageKey("C:\\", "win32")).toBe("C");
		expect(projectStorageKey("\\\\?\\nul", "win32")).toBe("_-nul");
	});

	it("never returns an empty key", () => {
		expect(projectStorageKey("", "win32")).toBe("_");
	});
});

describe("toPosixSeparators", () => {
	it("rewrites backslashes on Windows so one directory has one spelling", () => {
		expect(toPosixSeparators("C:\\Users\\user\\.dev3.0\\worktrees", "win32")).toBe("C:/Users/user/.dev3.0/worktrees");
	});

	it("leaves POSIX paths untouched, backslash included", () => {
		expect(toPosixSeparators("/Users/a/we\\ird", "darwin")).toBe("/Users/a/we\\ird");
	});
});

describe("listFilesystemRoots", () => {
	it("offers every present drive so a repo off the home drive is reachable", () => {
		const present = new Set(["C:\\", "D:\\"]);
		expect(listFilesystemRoots("win32", (p) => present.has(p))).toEqual(["C:\\", "D:\\"]);
	});

	it("omits drives that are not mounted", () => {
		expect(listFilesystemRoots("win32", (p) => p === "C:\\")).toEqual(["C:\\"]);
	});

	it("stays absent on POSIX, where the picker already offers /", () => {
		expect(listFilesystemRoots("darwin", () => true)).toBeUndefined();
		expect(listFilesystemRoots("linux", () => true)).toBeUndefined();
	});
});

describe("pathBasename", () => {
	it("names a project from a Windows path", () => {
		expect(pathBasename("D:\\src\\dev-3.0", "win32")).toBe("dev-3.0");
		expect(pathBasename("D:/src/dev-3.0", "win32")).toBe("dev-3.0");
		expect(pathBasename("D:\\src\\dev-3.0\\", "win32")).toBe("dev-3.0");
	});

	it("names a project from a POSIX path", () => {
		expect(pathBasename("/Users/a/dev-3.0", "darwin")).toBe("dev-3.0");
		expect(pathBasename("/Users/a/repo/", "darwin")).toBe("repo");
	});

	it("keeps a backslash inside a POSIX file name", () => {
		expect(pathBasename("/Users/a/we\\ird", "darwin")).toBe("we\\ird");
	});

	it("falls back to the input when there is no separator", () => {
		expect(pathBasename("repo", "win32")).toBe("repo");
	});
});
