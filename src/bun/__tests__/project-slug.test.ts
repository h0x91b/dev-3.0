import { describe, it, expect } from "vitest";
import { projectSlug } from "../git";

describe("projectSlug", () => {
	it("does not collide when path segments contain dashes", () => {
		// These two distinct paths used to collapse to the same slug because
		// "/" and "-" were both mapped to "-".
		const a = projectSlug("/foo/bar-baz");
		const b = projectSlug("/foo-bar/baz");
		expect(a).not.toBe(b);
	});

	it("does not collide for deeper multi-segment paths with dashes", () => {
		const a = projectSlug("/Users/dev/src/my-repo");
		const b = projectSlug("/Users/dev/src-my/repo");
		expect(a).not.toBe(b);
	});

	it("is deterministic (same input → same slug)", () => {
		const path = "/Users/arsenyp/Desktop/src-shared/dev-3.0";
		expect(projectSlug(path)).toBe(projectSlug(path));
	});

	it("produces a filesystem-safe string (no leading slash, no slashes)", () => {
		const slug = projectSlug("/Users/arsenyp/Desktop/my-repo");
		expect(slug.startsWith("/")).toBe(false);
		expect(slug.includes("/")).toBe(false);
	});
});
