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
import { buildUpdateChangelog, changelogKeyFromPath, selectReleaseWindow } from "../src/shared/update-changelog";

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

/** Release window: changelog files committed since the previous v* tag. */
function selectWindow(entries: ChangelogEntry[]): ChangelogEntry[] {
	// Previous release tag = newest v* tag not already pointing at HEAD.
	const pointsAtHead = new Set((git(["tag", "--points-at", "HEAD"]) ?? "").split("\n").filter(Boolean));
	const tags = (git(["tag", "--sort=-creatordate", "--merged", "HEAD"]) ?? "")
		.split("\n")
		.filter((t) => /^v/.test(t) && !pointsAtHead.has(t));
	const prevTag = tags[0];

	const changedKeys = new Set<string>();
	if (prevTag) {
		const diff = git(["diff", "--name-only", `${prevTag}`, "HEAD", "--", "change-logs"]);
		for (const line of (diff ?? "").split("\n")) {
			const key = changelogKeyFromPath(line);
			if (key) changedKeys.add(key);
		}
	}
	return selectReleaseWindow(entries, changedKeys);
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
