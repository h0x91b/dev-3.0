import { useEffect, useState } from "react";
import { getLang, highlighter, type SyntaxLine } from "@git-diff-view/core";

/** Past these the preview stays plain text — highlighting must never stall the modal. */
export const SYNTAX_MAX_CHARS = 512 * 1024;
export const SYNTAX_MAX_LINES = 20_000;
export const SYNTAX_MAX_LINE_CHARS = 10_000;

/** One coloured run of a line: the text plus its highlight.js token class, if any. */
export interface SyntaxToken {
	text: string;
	className?: string;
}

/**
 * Tokenise a whole file with the same lowlight highlighter the diff viewer uses,
 * so both surfaces colour code alike. The language comes from the file name;
 * an unknown one returns null (plain text) instead of falling back to auto-detection.
 */
export function highlightFileLines(content: string, path: string): Map<number, SyntaxToken[]> | null {
	if (content.length > SYNTAX_MAX_CHARS) return null;
	const lines = content.split("\n");
	if (lines.length > SYNTAX_MAX_LINES || lines.some((line) => line.length > SYNTAX_MAX_LINE_CHARS)) return null;
	const fileName = path.slice(path.lastIndexOf("/") + 1);
	const lang = getLang(fileName);
	if (!lang || !highlighter.hasRegisteredCurrentLang(lang)) return null;
	try {
		const ast = highlighter.getAST(content, fileName, lang);
		if (!ast) return null;
		const { syntaxFileObject } = highlighter.processAST(ast);
		const result = new Map<number, SyntaxToken[]>();
		for (const [lineNumber, line] of Object.entries(syntaxFileObject) as [string, SyntaxLine][]) {
			// Every line but the last carries its own "\n" in the final run; the
			// preview draws one element per line, so that newline would add a blank row.
			const tokens = line.nodeList.map(({ node, wrapper }) => ({
				text: node.value.replace(/\n$/, ""),
				className: wrapper?.properties?.className?.join(" ") || undefined,
			}));
			result.set(Number(lineNumber), tokens.filter((token) => token.text !== ""));
		}
		return result;
	} catch {
		return null;
	}
}

/**
 * Highlights after the plain text has painted, so a large file opens at once and
 * colours a moment later. Null until then, and for anything that stays plain.
 */
export function useSyntaxLines(content: string | null, path: string, enabled: boolean): Map<number, SyntaxToken[]> | null {
	const [lines, setLines] = useState<Map<number, SyntaxToken[]> | null>(null);
	useEffect(() => {
		setLines(null);
		if (!enabled || content === null) return;
		const timer = setTimeout(() => setLines(highlightFileLines(content, path)), 0);
		return () => clearTimeout(timer);
	}, [content, path, enabled]);
	return lines;
}
