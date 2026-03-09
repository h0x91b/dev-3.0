/**
 * Generates changelog.json at the project root with all changelog entries.
 * Run before every build so production builds have access to changelog data
 * (the change-logs/ directory is not bundled into the app).
 */

import { join } from "path";
import { readdirSync, existsSync } from "fs";
import type { ChangelogEntry } from "../src/shared/types";

const changeLogsDir = join(import.meta.dir, "..", "change-logs");

const entries: ChangelogEntry[] = [];

if (existsSync(changeLogsDir)) {
	for (const year of readdirSync(changeLogsDir)) {
		const yearPath = join(changeLogsDir, year);
		if (!/^\d{4}$/.test(year)) continue;
		for (const month of readdirSync(yearPath)) {
			const monthPath = join(yearPath, month);
			if (!/^\d{2}$/.test(month)) continue;
			for (const day of readdirSync(monthPath)) {
				const dayPath = join(monthPath, day);
				if (!/^\d{2}$/.test(day)) continue;
				for (const file of readdirSync(dayPath)) {
					if (!file.endsWith(".md") || file === "README.md") continue;
					const basename = file.replace(/\.md$/, "");
					const dashIdx = basename.indexOf("-");
					if (dashIdx === -1) continue;
					const type = basename.slice(0, dashIdx);
					const slug = basename.slice(dashIdx + 1);

					const content = await Bun.file(join(dayPath, file)).text();

					// Extract "Suggested by @username (owner/repo#N)" from any line
					let suggestedBy: string | undefined;
					let issueUrl: string | undefined;
					let issueRef: string | undefined;
					const creditMatch = content.match(/Suggested by @(\S+)\s+\(([^)]+)\)/);
					if (creditMatch) {
						suggestedBy = creditMatch[1];
						const ref = creditMatch[2];
						const refMatch = ref.match(/^(.+?)#(\d+)$/);
						if (refMatch) {
							issueRef = `#${refMatch[2]}`;
							issueUrl = `https://github.com/${refMatch[1]}/issues/${refMatch[2]}`;
						}
					}

					// Strip the "Suggested by" line before extracting title
					const cleanContent = content.replace(/\n*Suggested by @\S+\s+\([^)]+\)\s*$/, "").trim();
					const firstSentence =
						cleanContent.split(/\.(?:\s|$)/)[0]?.trim() ?? slug;
					const title =
						firstSentence.length > 120
							? firstSentence.slice(0, 117) + "..."
							: firstSentence;

					entries.push({
						date: `${year}-${month}-${day}`,
						type,
						slug,
						title: title || slug,
						...(suggestedBy && { suggestedBy }),
						...(issueUrl && { issueUrl }),
						...(issueRef && { issueRef }),
					});
				}
			}
		}
	}
}

entries.sort((a, b) => b.date.localeCompare(a.date));

const outPath = join(import.meta.dir, "..", "changelog.json");

await Bun.write(outPath, JSON.stringify(entries, null, "\t"));
console.log(`[changelog] ${entries.length} entries → changelog.json`);
