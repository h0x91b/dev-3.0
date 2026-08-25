/**
 * Error strings are the one telemetry channel that carries free-form text, and an
 * app wrapping git and worktrees puts absolute paths in them constantly. A path is
 * the customer's repo name and the user's own name — exactly what the README says
 * never leaves the machine.
 */
import { describe, it, expect } from "vitest";
import { redactPaths } from "../analytics";

describe("redactPaths", () => {
	it("keeps the basename and drops the directory tree above it", () => {
		expect(redactPaths("ENOENT, open '/Users/arseny/Desktop/src/acme-nda/config.ts'"))
			.toBe("ENOENT, open '…/config.ts'");
	});

	it("redacts Windows paths too", () => {
		expect(redactPaths("cannot read C:\\Users\\arseny\\projects\\acme\\index.ts"))
			.toBe("cannot read …/index.ts");
	});

	it("redacts the URL forms a webview error uses", () => {
		expect(redactPaths("at file:///Users/arseny/secret-client/app.js:1:2"))
			.toBe("at …/app.js:1:2");
		expect(redactPaths("views://mainview/assets/index-abc123.js"))
			.toBe("…/index-abc123.js");
	});

	it("redacts every path in one string, not just the first", () => {
		const redacted = redactPaths("copy /Users/a/nda-client/x.ts -> /Users/a/other-client/y.ts");
		expect(redacted).not.toContain("nda-client");
		expect(redacted).not.toContain("other-client");
		expect(redacted).toContain("x.ts");
		expect(redacted).toContain("y.ts");
	});

	it("leaves an ordinary message alone", () => {
		expect(redactPaths("Cannot read properties of undefined (reading 'id')"))
			.toBe("Cannot read properties of undefined (reading 'id')");
	});

	it("does not mangle a relative path, which carries no identity", () => {
		expect(redactPaths("failed at src/bun/git.ts:42")).toBe("failed at src/bun/git.ts:42");
	});
});
