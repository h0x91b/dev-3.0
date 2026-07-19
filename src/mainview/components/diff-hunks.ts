import type { TaskDiffFile } from "../../shared/types";

/** Which side of a rendered diff a line/comment anchors to. */
export type DiffSideKey = "oldFile" | "newFile";

export function getReviewFilePath(file: TaskDiffFile): string {
	return file.newPath ?? file.oldPath ?? file.displayPath;
}

export function parseDiffHunkLines(hunk: string): Array<{
	kind: "+" | "-" | " ";
	text: string;
	content: string;
	oldLine: number | null;
	newLine: number | null;
}> {
	const lines = hunk.split("\n");
	const parsed: Array<{
		kind: "+" | "-" | " ";
		text: string;
		content: string;
		oldLine: number | null;
		newLine: number | null;
	}> = [];
	let oldLine = 0;
	let newLine = 0;
	let inBody = false;

	for (const line of lines) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			inBody = true;
			continue;
		}
		if (!inBody || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) {
			continue;
		}

		const prefix = line[0];
		if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
			continue;
		}

		const entry = {
			kind: prefix,
			text: line,
			content: line.slice(1),
			oldLine: prefix === "+" ? null : oldLine,
			newLine: prefix === "-" ? null : newLine,
		} as const;
		parsed.push(entry);

		if (prefix !== "+") {
			oldLine += 1;
		}
		if (prefix !== "-") {
			newLine += 1;
		}
	}

	return parsed;
}

export function extractReviewSnippet(
	file: TaskDiffFile,
	side: DiffSideKey,
	startLine: number,
	endLine: number,
): { before: string | null; after: string | null } {
	const lineKey = side === "oldFile" ? "oldLine" : "newLine";
	for (const hunk of file.hunks ?? []) {
		const lines = parseDiffHunkLines(hunk);
		if (lines.length === 0) {
			continue;
		}

		const targetIndexes = lines
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => {
				const lineNumber = line[lineKey];
				return lineNumber !== null && lineNumber >= startLine && lineNumber <= endLine;
			})
			.map(({ index }) => index);

		if (targetIndexes.length === 0) {
			continue;
		}

		let from = targetIndexes[0];
		let to = targetIndexes[targetIndexes.length - 1];
		while (from > 0 && lines[from - 1]?.kind !== " ") {
			from -= 1;
		}
		while (to < lines.length - 1 && lines[to + 1]?.kind !== " ") {
			to += 1;
		}

		const block = lines.slice(from, to + 1).map((line, relativeIndex) => ({
			...line,
			relativeIndex,
		}));
		const targetRelativeIndex = targetIndexes[0] - from;
		const targetLine = block[targetRelativeIndex];

		if (!targetLine) {
			continue;
		}

		if (targetLine.kind === " ") {
			return {
				before: targetLine.content,
				after: targetLine.content,
			};
		}

		const removedLines = block.filter((line) => line.kind === "-");
		const addedLines = block.filter((line) => line.kind === "+");

		if (targetLine.kind === "-") {
			const removedIndex = removedLines.findIndex((line) => line.relativeIndex === targetRelativeIndex);
			return {
				before: targetLine.content,
				after: removedIndex >= 0 && removedIndex < addedLines.length
					? addedLines[removedIndex]?.content ?? null
					: null,
			};
		}

		const addedIndex = addedLines.findIndex((line) => line.relativeIndex === targetRelativeIndex);
		return {
			before: addedIndex >= 0 && addedIndex < removedLines.length
				? removedLines[addedIndex]?.content ?? null
				: null,
			after: targetLine.content,
		};
	}

	const fallbackLines = (side === "oldFile" ? file.oldContent : file.newContent).split("\n");
	const selected = fallbackLines
		.slice(Math.max(0, startLine - 1), endLine)
		.find((line) => line.length > 0) ?? null;
	return side === "oldFile"
		? { before: selected, after: null }
		: { before: null, after: selected };
}
