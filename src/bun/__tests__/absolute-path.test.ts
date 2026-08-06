import { describe, it, expect } from "vitest";
import { isFullyQualifiedPath } from "../../shared/absolute-path";

// The guard is a shape check, not a sandbox: it decides whether a caller handed
// us a fully-qualified path. Its value lives in what it REFUSES, so the
// rejection cases carry the same weight as the acceptances.
describe("isFullyQualifiedPath", () => {
	it("accepts a POSIX absolute path on macOS/Linux", () => {
		expect(
			isFullyQualifiedPath("/Users/me/.dev3.0/worktrees/p/uploads/a.png", "darwin"),
			"cause: POSIX absolute paths rejected on darwin. fix: keep the leading-slash branch in isFullyQualifiedPath",
		).toBe(true);
	});

	it("accepts a drive-qualified Windows path with either separator", () => {
		// The whole reason this helper exists: an uploaded path on Windows is
		// "C:/Users/...", which a POSIX-only startsWith("/") check rejected, so the
		// New Task thumbnail rendered "Load failed".
		expect(
			isFullyQualifiedPath("C:/Users/user/.dev3.0/uploads/a.png", "win32"),
			"cause: forward-slash Windows path rejected. fix: accept /^[A-Za-z]:[\\\\/]/ in isFullyQualifiedPath",
		).toBe(true);
		expect(
			isFullyQualifiedPath("C:\\Users\\user\\uploads\\a.png", "win32"),
			"cause: backslash Windows path rejected. fix: accept /^[A-Za-z]:[\\\\/]/ in isFullyQualifiedPath",
		).toBe(true);
	});

	it("accepts a UNC share path on Windows", () => {
		expect(
			isFullyQualifiedPath("\\\\fileserver\\share\\a.png", "win32"),
			"cause: UNC path rejected. fix: accept /^\\\\\\\\[^\\\\/]/ in isFullyQualifiedPath",
		).toBe(true);
	});

	it("rejects a drive-RELATIVE Windows path that only looks absolute", () => {
		// "C:foo" resolves against the process's per-drive cwd — fully qualified it
		// is not, and it is the one Windows shape that fools a naive check.
		expect(
			isFullyQualifiedPath("C:foo\\a.png", "win32"),
			"cause: drive-relative C:foo accepted as fully qualified. fix: require a separator after the colon",
		).toBe(false);
		expect(
			isFullyQualifiedPath("C:", "win32"),
			"cause: bare drive letter accepted. fix: require a separator after the colon",
		).toBe(false);
	});

	it("rejects Windows shapes when the platform is not win32", () => {
		expect(
			isFullyQualifiedPath("C:/Users/me/a.png", "darwin"),
			"cause: Windows path accepted on darwin, where it is a relative name. fix: gate the Windows branches on platform === win32",
		).toBe(false);
	});

	it("rejects relative paths, empty input, and anything containing ..", () => {
		expect(
			isFullyQualifiedPath("uploads/a.png", "darwin"),
			"cause: relative path accepted. fix: return false unless the path is rooted",
		).toBe(false);
		expect(
			isFullyQualifiedPath("", "darwin"),
			"cause: empty path accepted. fix: guard the empty string first",
		).toBe(false);
		expect(
			isFullyQualifiedPath("/Users/me/../../etc/passwd", "darwin"),
			'cause: ".." traversal accepted. fix: keep the path.includes("..") rejection',
		).toBe(false);
		expect(
			isFullyQualifiedPath("C:\\Users\\me\\..\\..\\Windows\\x", "win32"),
			'cause: ".." traversal accepted on Windows. fix: check for ".." before the platform branches',
		).toBe(false);
		expect(
			isFullyQualifiedPath("\\Users\\me\\a.png", "win32"),
			"cause: root-relative \\path accepted; on Windows it is drive-relative. fix: do not treat a single leading backslash as qualified",
		).toBe(false);
	});
});
