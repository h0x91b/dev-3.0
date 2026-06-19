/**
 * Regression test for a stale-content bug in the diff viewer.
 *
 * Background: `@git-diff-view/core` caches its internal `File` instances keyed
 * purely by the `uuid` argument passed to the `DiffFile` constructor. When we
 * pass a stable uuid (like the file path), the cache returns the previously
 * built `File` even if the actual old/new content has changed — e.g. after the
 * user rebases the branch. The UI then renders stale content on the new side
 * while the hunk header reflects the fresh diff, producing a confusing mismatch.
 *
 * These tests use generic `feature-v4` / `feature-v5` variants — deliberately
 * unrelated to any private project — so the reproduction lives fully inside
 * the open-source repo.
 */
import { DiffFile } from "@git-diff-view/core";
import type { TaskDiffFile } from "../../../shared/types";
import { getDiffFileContentHash } from "../TaskDiffViewer";

const OLD_CONTENT_COMMON = "line a\nline b\nline c\n";

const V4_NEW_CONTENT =
	"line a\nline b\nline c\n\n\n# feature-v4 buckets\nFEATURE_V4_VARIANTS = {\"v4\"}\n\n\ndef is_v4(v):\n  return v in FEATURE_V4_VARIANTS\n";

const V5_NEW_CONTENT =
	"line a\nline b\nline c\n\n\n# feature-v5 buckets\nFEATURE_V5_VARIANTS = {\"v5-alpha\", \"v5-beta\"}\n\n\ndef is_v5(variant):\n  return variant in FEATURE_V5_VARIANTS\n";

const V4_HUNK = `@@ -1,3 +1,11 @@\n line a\n line b\n line c\n+\n+\n+# feature-v4 buckets\n+FEATURE_V4_VARIANTS = {"v4"}\n+\n+\n+def is_v4(v):\n+  return v in FEATURE_V4_VARIANTS\n`;

const V5_HUNK = `@@ -1,3 +1,13 @@\n line a\n line b\n line c\n+\n+\n+# feature-v5 buckets\n+FEATURE_V5_VARIANTS = {"v5-alpha", "v5-beta"}\n+\n+\n+def is_v5(variant):\n+  return variant in FEATURE_V5_VARIANTS\n+\n+\n`;

function renderNewSide(newContent: string, hunk: string, uuid: string): string[] {
	const file = new DiffFile("f.py", OLD_CONTENT_COMMON, "f.py", newContent, [hunk], undefined, undefined, uuid);
	file.initTheme("dark");
	file.initRaw();
	file.buildSplitDiffLines();
	const out: string[] = [];
	const limit = file.splitLineLength ?? 40;
	for (let i = 0; i < limit; i++) {
		const line = file.getSplitRightLine(i);
		if (line?.value) {
			out.push(line.value.replace(/\n$/, ""));
		}
	}
	return out;
}

function fileFor(oldContent: string, newContent: string, hunk: string): TaskDiffFile {
	return {
		id: "feature_flags.py",
		status: "modified",
		displayPath: "feature_flags.py",
		oldPath: "feature_flags.py",
		newPath: "feature_flags.py",
		oldContent,
		newContent,
		hunks: [hunk],
		insertions: 1,
		deletions: 1,
	};
}

describe("@git-diff-view core cache (regression)", () => {
	// Confirms the underlying library bug: a stable uuid causes stale content.
	// If this test ever starts failing (i.e. the library fixes its cache), we can
	// drop the content hash from our uuid construction and simplify the code.
	it("returns stale content when the same uuid is reused across content changes", () => {
		const STABLE_UUID = "feature_flags.py";

		// Pre-warm the cache with v4 content.
		const v4 = renderNewSide(V4_NEW_CONTENT, V4_HUNK, STABLE_UUID);
		expect(v4.some((line) => line.includes("v4"))).toBe(true);

		// Render again with fresh v5 content but the SAME uuid — library returns stale v4.
		const leaked = renderNewSide(V5_NEW_CONTENT, V5_HUNK, STABLE_UUID);
		expect(leaked.some((line) => line.includes("v4"))).toBe(true);
		expect(leaked.some((line) => line.includes("v5"))).toBe(false);
	});
});

describe("getDiffFileContentHash", () => {
	it("produces different hashes for different new content (invalidates library cache)", () => {
		const v4File = fileFor(OLD_CONTENT_COMMON, V4_NEW_CONTENT, V4_HUNK);
		const v5File = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V5_HUNK);
		expect(getDiffFileContentHash(v4File)).not.toBe(getDiffFileContentHash(v5File));
	});

	it("produces identical hashes for identical content (allows cache reuse)", () => {
		const a = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V5_HUNK);
		const b = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V5_HUNK);
		expect(getDiffFileContentHash(a)).toBe(getDiffFileContentHash(b));
	});

	it("detects hunk-only changes even if content strings happen to match", () => {
		const base = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V5_HUNK);
		const mutated = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V4_HUNK);
		expect(getDiffFileContentHash(base)).not.toBe(getDiffFileContentHash(mutated));
	});

	it("detects content-only changes even if hunk strings happen to match", () => {
		const stableHunk = "@@ -1 +1 @@\n-old value\n+new value\n";
		const base = fileFor("old value\ncontext one\n", "new value\ncontext one\n", stableHunk);
		const mutated = fileFor("old value\ncontext two\n", "new value\ncontext two\n", stableHunk);
		expect(getDiffFileContentHash(base)).not.toBe(getDiffFileContentHash(mutated));
	});

	it("renders fresh content when uuid includes the content hash", () => {
		const v4File = fileFor(OLD_CONTENT_COMMON, V4_NEW_CONTENT, V4_HUNK);
		const v5File = fileFor(OLD_CONTENT_COMMON, V5_NEW_CONTENT, V5_HUNK);

		const v4Uuid = `${v4File.id}:${getDiffFileContentHash(v4File)}`;
		const v5Uuid = `${v5File.id}:${getDiffFileContentHash(v5File)}`;

		// Pre-warm with v4.
		renderNewSide(V4_NEW_CONTENT, V4_HUNK, v4Uuid);
		// Render v5 with the content-aware uuid — the library cache miss forces a fresh build.
		const fresh = renderNewSide(V5_NEW_CONTENT, V5_HUNK, v5Uuid);

		expect(fresh.some((line) => line.includes("v5"))).toBe(true);
		expect(fresh.some((line) => line.includes("v4"))).toBe(false);
	});
});
