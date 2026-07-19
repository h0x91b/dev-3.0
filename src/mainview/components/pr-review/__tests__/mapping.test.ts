import { describe, expect, it } from "vitest";
import type { PRReviewThread, TaskDiffFile } from "../../../../shared/types";
import type { DiffSideKey } from "../../diff-hunks";
import {
	buildThreadFixPrompt,
	groupGithubThreadsByFile,
	isLineRenderedInDiff,
	locateThread,
	partitionThreadsForDiff,
} from "../mapping";

function makeFile(overrides: Partial<TaskDiffFile> = {}): TaskDiffFile {
	return {
		id: "src/app.ts",
		status: "modified",
		displayPath: "src/app.ts",
		oldPath: "src/app.ts",
		newPath: "src/app.ts",
		oldContent: 'const a = "one";\n',
		newContent: 'const a = "two";\nconst b = 3;\n',
		hunks: null,
		insertions: 2,
		deletions: 1,
		...overrides,
	};
}

function makeThread(overrides: Partial<PRReviewThread> = {}): PRReviewThread {
	return {
		id: "th1",
		path: "src/app.ts",
		line: 1,
		originalLine: 1,
		startLine: null,
		diffSide: "RIGHT",
		isResolved: false,
		isOutdated: false,
		comments: [
			{
				id: "c1",
				author: "alice",
				isBot: false,
				body: "Rename this variable.",
				createdAt: "2026-07-18T10:00:00Z",
				url: "https://github.com/acme/widget/pull/42#discussion_r1",
			},
		],
		...overrides,
	};
}

describe("groupGithubThreadsByFile", () => {
	it("groups threads under the matching diff file id", () => {
		const groups = groupGithubThreadsByFile([makeFile()], [makeThread()], { showResolved: false });
		expect(groups.byFile["src/app.ts"]).toHaveLength(1);
		expect(groups.unmappedCount).toBe(0);
	});

	it("hides resolved threads unless showResolved is on", () => {
		const threads = [makeThread({ isResolved: true })];
		expect(groupGithubThreadsByFile([makeFile()], threads, { showResolved: false }).byFile["src/app.ts"]).toBeUndefined();
		expect(groupGithubThreadsByFile([makeFile()], threads, { showResolved: true }).byFile["src/app.ts"]).toHaveLength(1);
	});

	it("groups threads on files absent from the diff, sorted by path", () => {
		const threads = [
			makeThread({ id: "th-b", path: "zzz/other.ts" }),
			makeThread({ id: "th-a", path: "aaa/gone.ts" }),
		];
		const groups = groupGithubThreadsByFile([makeFile()], threads, { showResolved: false });
		expect(groups.unmapped.map((group) => group.path)).toEqual(["aaa/gone.ts", "zzz/other.ts"]);
		expect(groups.unmappedCount).toBe(2);
	});

	it("matches renamed files via oldPath", () => {
		const file = makeFile({ id: "renamed", oldPath: "src/old-name.ts", newPath: "src/app.ts" });
		const groups = groupGithubThreadsByFile([file], [makeThread({ path: "src/old-name.ts" })], { showResolved: false });
		expect(groups.byFile.renamed).toHaveLength(1);
	});
});

describe("partitionThreadsForDiff", () => {
	const renderedLines: Record<DiffSideKey, number[]> = { oldFile: [1], newFile: [1, 2] };
	const isRendered = (side: DiffSideKey, line: number) => renderedLines[side].includes(line);

	it("anchors a thread whose line the diff renders", () => {
		const { inline, outdated } = partitionThreadsForDiff([makeThread({ line: 2 })], isRendered);
		expect(inline.newFile[2]).toHaveLength(1);
		expect(outdated).toHaveLength(0);
	});

	it("anchors LEFT threads onto the old side", () => {
		const { inline } = partitionThreadsForDiff([makeThread({ diffSide: "LEFT", line: 1 })], isRendered);
		expect(inline.oldFile[1]).toHaveLength(1);
	});

	it("sends GitHub-flagged outdated threads to the outdated group", () => {
		const { inline, outdated } = partitionThreadsForDiff([makeThread({ isOutdated: true })], isRendered);
		expect(Object.keys(inline.newFile)).toHaveLength(0);
		expect(outdated).toHaveLength(1);
	});

	it("sends threads with a null line to the outdated group", () => {
		const { outdated } = partitionThreadsForDiff([makeThread({ line: null })], isRendered);
		expect(outdated).toHaveLength(1);
	});

	it("sends threads whose line the diff does not render to the outdated group", () => {
		// The worktree moved past the PR head: GitHub still reports line 466,
		// but the rendered diff has no such row.
		const { outdated } = partitionThreadsForDiff([makeThread({ line: 466 })], isRendered);
		expect(outdated).toHaveLength(1);
	});

	it("stacks multiple threads anchored to the same line", () => {
		const { inline } = partitionThreadsForDiff(
			[makeThread({ id: "a", line: 1 }), makeThread({ id: "b", line: 1 })],
			isRendered,
		);
		expect(inline.newFile[1].map((thread) => thread.id)).toEqual(["a", "b"]);
	});
});

describe("isLineRenderedInDiff", () => {
	const splitSide = { old: 0, new: 1 };
	const instance = {
		getUnifiedLineIndexByLineNumber: (line: number, side: number) =>
			(side === splitSide.new && (line === 5 || line === 9)) ? line : -1,
		getUnifiedLine: (index: number) => (index === 9 ? { isHidden: true } : { isHidden: false }),
		getSplitLineIndexByLineNumber: (line: number, side: number) => (side === splitSide.old && line === 3 ? 0 : -1),
		getSplitLeftLine: () => ({ isHidden: false, lineNumber: 3 }),
		getSplitRightLine: () => undefined,
	};

	it("reports rendered unified lines", () => {
		expect(isLineRenderedInDiff(instance, "unified", splitSide, "newFile", 5)).toBe(true);
		expect(isLineRenderedInDiff(instance, "unified", splitSide, "newFile", 6)).toBe(false);
	});

	it("treats hidden (collapsed-context) lines as not rendered", () => {
		expect(isLineRenderedInDiff(instance, "unified", splitSide, "newFile", 9)).toBe(false);
	});

	it("reports rendered split lines per side", () => {
		expect(isLineRenderedInDiff(instance, "split", splitSide, "oldFile", 3)).toBe(true);
		expect(isLineRenderedInDiff(instance, "split", splitSide, "newFile", 3)).toBe(false);
	});

	it("fails closed on instances without the lookup API", () => {
		expect(isLineRenderedInDiff({}, "unified", splitSide, "newFile", 1)).toBe(false);
	});
});

describe("locateThread", () => {
	it("resolves the file, side, and line", () => {
		const location = locateThread([makeFile()], makeThread({ line: 2 }));
		expect(location?.file.id).toBe("src/app.ts");
		expect(location?.side).toBe("newFile");
		expect(location?.line).toBe(2);
	});

	it("falls back to originalLine and returns null when nothing resolves", () => {
		expect(locateThread([makeFile()], makeThread({ line: null, originalLine: 5 }))?.line).toBe(5);
		expect(locateThread([makeFile()], makeThread({ line: null, originalLine: null }))).toBeNull();
		expect(locateThread([], makeThread())).toBeNull();
	});
});

describe("buildThreadFixPrompt", () => {
	it("includes the file, line, snippet, comment bodies, and thread link", () => {
		const thread = makeThread();
		const prompt = buildThreadFixPrompt(thread, locateThread([makeFile()], thread));
		expect(prompt).toContain("File: src/app.ts, line 1");
		expect(prompt).toContain('+const a = "two";');
		expect(prompt).toContain("[alice] wrote:");
		expect(prompt).toContain("Rename this variable.");
		expect(prompt).toContain("https://github.com/acme/widget/pull/42#discussion_r1");
	});

	it("notes outdated threads and survives a missing location", () => {
		const prompt = buildThreadFixPrompt(makeThread({ isOutdated: true, line: null, originalLine: 7 }), null);
		expect(prompt).toContain("line 7");
		expect(prompt).toContain("outdated");
		expect(prompt).not.toContain("Code:");
	});
});
