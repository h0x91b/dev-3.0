/**
 * Prints the full Markdown "what's new" section for the GitHub Release body —
 * Features, then Fixes, then Refactors (full titles) — for the current release
 * window (the same window as the update popover; see build-update-changelog.ts).
 * Prints nothing on failure so a broken step never blocks publishing.
 *
 * Usage: `bun scripts/build-release-notes.ts <version?>` (version also read from
 * the RELEASE_TAG env var); it heads the section as "What's new in <version>".
 */

import { join } from "path";
import { existsSync } from "fs";
import type { ChangelogEntry } from "../src/shared/types";
import { buildReleaseNotesSections, renderReleaseNotesMarkdown } from "../src/shared/update-changelog";
import { selectReleaseWindowFromGit } from "./release-window";

const root = join(import.meta.dir, "..");
const version = process.argv[2] || process.env.RELEASE_TAG || undefined;

async function main() {
	const changelogPath = join(root, "changelog.json");
	if (!existsSync(changelogPath)) return;
	const entries: ChangelogEntry[] = JSON.parse(await Bun.file(changelogPath).text());
	const sections = buildReleaseNotesSections(selectReleaseWindowFromGit(entries));
	process.stdout.write(renderReleaseNotesMarkdown(sections, version));
}

main().catch(() => {});
