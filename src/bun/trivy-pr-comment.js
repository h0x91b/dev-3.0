const COMMENT_HEADER = "## 🔍 Trivy Vulnerability Scan\n\n";

const FINDING_FREE_HEADERS = new Set([
	"vulnerabilities",
	"misconfigurations",
	"secrets",
	"licenses",
]);

function normalizeCell(value) {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isFindingFreeCell(value) {
	const normalized = normalizeCell(value);

	if (
		normalized === "" ||
		normalized === "-" ||
		normalized === "none" ||
		normalized === "n/a"
	) {
		return true;
	}

	if (/^0+([./]0+)?$/.test(normalized)) {
		return true;
	}

	return (
		normalized.includes("clean") ||
		normalized.includes("not scanned") ||
		normalized.includes("no security findings")
	);
}

function parseRow(line) {
	return line
		.split("│")
		.slice(1, -1)
		.map((cell) => cell.trim());
}

function parseTrivyTable(results) {
	const lines = results
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const tableLines = lines.filter((line) => line.startsWith("│"));

	if (tableLines.length < 2) {
		return null;
	}

	const header = parseRow(tableLines[0]);
	const rows = tableLines
		.slice(1)
		.map(parseRow)
		.filter((row) => row.some((cell) => cell.length > 0));
	const legendIndex = lines.findIndex((line) => line === "Legend:");
	const legendLines =
		legendIndex === -1
			? []
			: lines.slice(legendIndex + 1).filter((line) => line.startsWith("-"));

	return { header, rows, legendLines };
}

function hasOnlyFindingFreeSummaryRows(header, rows) {
	const relevantIndexes = header
		.map((cell, index) =>
			FINDING_FREE_HEADERS.has(normalizeCell(cell)) ? index : -1,
		)
		.filter((index) => index !== -1);

	if (relevantIndexes.length === 0 || rows.length === 0) {
		return false;
	}

	return rows.every((row) =>
		relevantIndexes.every((index) => isFindingFreeCell(row[index] ?? "")),
	);
}

function shouldSkipTrivyComment(results) {
	const normalizedResults = results.trim();

	if (normalizedResults.length === 0) {
		return true;
	}

	const normalizedText = normalizeCell(normalizedResults);
	if (
		normalizedText.includes("no vulnerabilities found") ||
		normalizedText.includes("clean (no security findings detected)")
	) {
		return true;
	}

	const table = parseTrivyTable(normalizedResults);
	return table
		? hasOnlyFindingFreeSummaryRows(table.header, table.rows)
		: false;
}

function buildTrivyCommentBody(results) {
	const normalizedResults = results.trim();

	if (shouldSkipTrivyComment(normalizedResults)) {
		return null;
	}

	let body = COMMENT_HEADER;
	const table = parseTrivyTable(normalizedResults);

	if (table) {
		body += "### Report Summary\n\n";
		body += `| ${table.header.join(" | ")} |\n`;
		body += `| ${table.header.map(() => "---").join(" | ")} |\n`;
		body += table.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
		body += "\n";

		if (table.legendLines.length > 0) {
			body += "\n";
			body += table.legendLines.join("\n");
			body += "\n";
		}

		return body;
	}

	body += "### Raw Output\n\n";
	body += `\`\`\`\n${normalizedResults}\n\`\`\`\n`;
	return body;
}

module.exports = {
	buildTrivyCommentBody,
	parseTrivyTable,
	shouldSkipTrivyComment,
};
