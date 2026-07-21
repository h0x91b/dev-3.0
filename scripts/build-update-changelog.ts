/**
 * Prints the compact "what's new" JSON embedded into the release `update.json`
 * (see scripts/create-release-artifacts.sh). The update popover renders it and
 * links to the full Changelog screen. Prints `null` on any failure — the client
 * treats an absent/`null` changelog as "no what's-new section", so a broken
 * build step can never break the update flow.
 *
 * Release window = changelog entries added since the previous release tag
 * (`git diff <prevTag> HEAD`). Falls back to the most recent day's batch when
 * git/tags are unavailable (e.g. a shallow CI checkout).
 */

import { join } from "path";
import { existsSync } from "fs";
import type { ChangelogEntry } from "../src/shared/types";
import { buildUpdateChangelog } from "../src/shared/update-changelog";

const root = join(import.meta.dir, "..");

function git(args: string[]): string | null {
	try {
		const proc = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "ignore" });
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString().trim();
	} catch {
		return null;
	}
}

/** change-logs/2026/07/21/feature-foo.md → { date, type, slug } */
function keyFromPath(path: string): { date: string; type: string; slug: string } | null {
	const m = path.match(/change-logs\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.md$/);
	if (!m) return null;
	const basename = m[4];
	if (basename === "README") return null;
	const dashIdx = basename.indexOf("-");
	if (dashIdx === -1) return null;
	return {
		date: `${m[1]}-${m[2]}-${m[3]}`,
		type: basename.slice(0, dashIdx),
		slug: basename.slice(dashIdx + 1),
	};
}

function selectWindow(entries: ChangelogEntry[]): ChangelogEntry[] {
	// Previous release tag = newest v* tag not already pointing at HEAD.
	const pointsAtHead = new Set((git(["tag", "--points-at", "HEAD"]) ?? "").split("\n").filter(Boolean));
	const tags = (git(["tag", "--sort=-creatordate", "--merged", "HEAD"]) ?? "")
		.split("\n")
		.filter((t) => /^v/.test(t) && !pointsAtHead.has(t));
	const prevTag = tags[0];

	if (prevTag) {
		const diff = git(["diff", "--name-only", `${prevTag}`, "HEAD", "--", "change-logs"]);
		if (diff !== null) {
			const keys = new Set(
				diff
					.split("\n")
					.map(keyFromPath)
					.filter((k): k is NonNullable<typeof k> => k !== null)
					.map((k) => `${k.date}|${k.type}|${k.slug}`),
			);
			const windowEntries = entries.filter((e) => keys.has(`${e.date}|${e.type}|${e.slug}`));
			if (windowEntries.length > 0) return windowEntries;
		}
	}

	// Fallback: the most recent day's batch (entries are sorted date-desc).
	if (entries.length === 0) return [];
	const newestDate = entries[0].date;
	const batch = entries.filter((e) => e.date === newestDate);
	return batch.length > 0 ? batch : entries.slice(0, 10);
}

async function main() {
	const changelogPath = join(root, "changelog.json");
	if (!existsSync(changelogPath)) {
		process.stdout.write("null");
		return;
	}
	const entries: ChangelogEntry[] = JSON.parse(await Bun.file(changelogPath).text());
	const payload = buildUpdateChangelog(selectWindow(entries));
	process.stdout.write(JSON.stringify(payload));
}

main().catch(() => {
	process.stdout.write("null");
});
