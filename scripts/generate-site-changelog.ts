#!/usr/bin/env bun
/**
 * Writes docs/changelog/index.html for the landing site. Runs in the Pages
 * deploy (.github/workflows/pages.yml); the output is gitignored, never committed.
 *
 * Release list and dates come from published GitHub Releases (`gh release list`),
 * entries from changelog.json, and each entry is attributed to the first release
 * whose tag tree contains its change-logs/ file. Needs full history + tags and a
 * logged-in `gh` (GH_TOKEN in CI). Fails loudly rather than deploying a guess.
 *
 *   bun scripts/generate-changelog.ts && bun scripts/generate-site-changelog.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ChangelogEntry } from "../src/shared/types";
import { assignEntriesToReleases, renderSiteChangelogPage, type PublishedRelease } from "../src/shared/site-changelog";

const ROOT = join(import.meta.dir, "..");
const REPO = process.env.GITHUB_REPOSITORY || "h0x91b/dev-3.0";
const OUT = join(ROOT, "docs", "changelog", "index.html");

function run(cmd: string[]): string {
	const proc = Bun.spawnSync(cmd, { cwd: ROOT, stderr: "pipe" });
	if (proc.exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	}
	return proc.stdout.toString();
}

const changelogPath = join(ROOT, "changelog.json");
if (!existsSync(changelogPath)) throw new Error("changelog.json missing — run scripts/generate-changelog.ts first");
const entries: ChangelogEntry[] = JSON.parse(readFileSync(changelogPath, "utf8"));

type GhRelease = { tagName: string; publishedAt: string; isDraft: boolean; isPrerelease: boolean };
const ghReleases: GhRelease[] = JSON.parse(
	run(["gh", "release", "list", "--repo", REPO, "--limit", "1000", "--json", "tagName,publishedAt,isDraft,isPrerelease"]),
);
const releases: PublishedRelease[] = ghReleases
	.filter((r) => !r.isDraft && !r.isPrerelease && /^v\d/.test(r.tagName))
	.map((r) => ({ tag: r.tagName, publishedAt: r.publishedAt }));
if (releases.length === 0) throw new Error("gh returned no published releases");

const fileNamesByTag = new Map<string, string[]>();
for (const { tag } of releases) {
	const paths = run(["git", "ls-tree", "-r", "--name-only", `refs/tags/${tag}`, "--", "change-logs"]);
	fileNamesByTag.set(
		tag,
		paths
			.split("\n")
			.filter((p) => /^change-logs\/\d{4}\/\d{2}\/\d{2}\/.+\.md$/.test(p))
			.map((p) => basename(p)),
	);
}

const site = assignEntriesToReleases(releases, fileNamesByTag, entries);
mkdirSync(join(ROOT, "docs", "changelog"), { recursive: true });
writeFileSync(OUT, renderSiteChangelogPage(site, `https://github.com/${REPO}`));
const shipped = site.reduce((n, r) => n + r.sections.reduce((m, s) => m + s.titles.length, 0), 0);
console.log(`[site-changelog] ${site.length} releases, ${shipped} entries → docs/changelog/index.html`);
