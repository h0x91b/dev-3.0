/**
 * Prints the compact "what's new" JSON embedded into the release `update.json`
 * (see scripts/create-release-artifacts.sh). The update popover renders it and
 * links to the full Changelog screen. Prints `null` on any failure — the client
 * treats an absent/`null` changelog as "no what's-new section", so a broken
 * build step can never break the update flow.
 *
 * Release window = changelog entries added since the previous release tag,
 * resolved from git by {@link selectReleaseWindowFromGit}.
 */

import { join } from "path";
import { existsSync } from "fs";
import type { ChangelogEntry } from "../src/shared/types";
import { buildUpdateChangelog } from "../src/shared/update-changelog";
import { selectReleaseWindowFromGit } from "./release-window";

const root = join(import.meta.dir, "..");

async function main() {
	const changelogPath = join(root, "changelog.json");
	if (!existsSync(changelogPath)) {
		process.stdout.write("null");
		return;
	}
	const entries: ChangelogEntry[] = JSON.parse(await Bun.file(changelogPath).text());
	const payload = buildUpdateChangelog(selectReleaseWindowFromGit(entries));
	process.stdout.write(JSON.stringify(payload));
}

main().catch(() => {
	process.stdout.write("null");
});
