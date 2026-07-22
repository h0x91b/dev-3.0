/**
 * Resolves the current release window — the changelog entries whose files
 * changed since the previous `v*` tag — from git. Shared by the update-popover
 * payload (build-update-changelog.ts) and the GitHub Release notes
 * (build-release-notes.ts) so both describe the same set of changes.
 *
 * Requires a checkout with full history + tags; a shallow/tag-less clone leaves
 * `prevTag` null and falls back to the most-recent-day batch (see decision 152,
 * why release.yml uses fetch-depth: 0).
 */

import { join } from "path";
import type { ChangelogEntry } from "../src/shared/types";
import { changelogKeyFromPath, selectReleaseWindow } from "../src/shared/update-changelog";

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

export function selectReleaseWindowFromGit(entries: ChangelogEntry[]): ChangelogEntry[] {
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
