import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasAgentAdapter } from "../../shared/agent-adapters/registry";
import {
	assignEntriesToReleases,
	fullEntryTitle,
	renderSiteChangelogPage,
	type PublishedRelease,
} from "../../shared/site-changelog";
import type { ChangelogEntry } from "../../shared/types";

const REPO_ROOT = join(__dirname, "..", "..", "..");

const entry = (type: string, slug: string, title = slug, body?: string): ChangelogEntry => ({
	date: "2026-01-01",
	type,
	slug,
	title,
	...(body && { body }),
});

const releases: PublishedRelease[] = [
	{ tag: "v1.1.0", publishedAt: "2026-02-01T10:00:00Z" },
	{ tag: "v1.0.0", publishedAt: "2026-01-01T10:00:00Z" },
];

describe("assignEntriesToReleases", () => {
	it("credits an entry to the first release that shipped it, even after its file moved or changed", () => {
		const tree = new Map([
			["v1.0.0", ["feature-a.md"]],
			["v1.1.0", ["feature-a.md", "fix-b.md"]],
		]);
		const site = assignEntriesToReleases(releases, tree, [entry("feature", "a"), entry("fix", "b")]);

		expect(site.map((r) => r.tag)).toEqual(["v1.1.0", "v1.0.0"]);
		expect(site[1].sections).toEqual([{ heading: "Features", titles: ["a"] }]);
		expect(site[0].sections).toEqual([{ heading: "Fixes", titles: ["b"] }]);
	});

	it("leaves out entries no published release contains yet", () => {
		const site = assignEntriesToReleases(releases, new Map([["v1.0.0", []], ["v1.1.0", []]]), [
			entry("feature", "unreleased"),
		]);
		expect(site.every((r) => r.sections.length === 0)).toBe(true);
	});
});

describe("fullEntryTitle", () => {
	it("restores the whole first sentence when the popover title was truncated", () => {
		const e = entry("fix", "x", "A long sentence that got cut...", "A long sentence that got cut at the end. Second one.");
		expect(fullEntryTitle(e)).toBe("A long sentence that got cut at the end");
	});

	it("keeps a title that was not truncated", () => {
		expect(fullEntryTitle(entry("fix", "x", "Short title", "Short title. More detail."))).toBe("Short title");
	});
});

describe("renderSiteChangelogPage", () => {
	it("escapes entry text, renders inline code and links each release to GitHub", () => {
		const html = renderSiteChangelogPage(
			[{ tag: "v1.0.0", publishedAt: "2026-01-01T10:00:00Z", sections: [{ heading: "Fixes", titles: ["Use `dev3 <x>` & co"] }] }],
			"https://github.com/h0x91b/dev-3.0",
		);
		expect(html).toContain("<li>Use <code>dev3 &lt;x&gt;</code> &amp; co</li>");
		expect(html).toContain('<time datetime="2026-01-01">2026-01-01</time>');
		expect(html).toContain('href="https://github.com/h0x91b/dev-3.0/releases/tag/v1.0.0"');
	});
});

describe("docs/integrations page", () => {
	it("lists every agent that has a built-in adapter", () => {
		const page = readFileSync(join(REPO_ROOT, "docs/integrations/index.html"), "utf8");
		const adapterDir = join(REPO_ROOT, "src/shared/agent-adapters");
		const commands = readdirSync(adapterDir)
			.map((f) => readFileSync(join(adapterDir, f), "utf8").match(/^\tcommand: "([^"]+)",$/m)?.[1])
			.filter((c): c is string => !!c && hasAgentAdapter(c));

		expect(commands.length).toBeGreaterThanOrEqual(7);
		for (const command of commands) expect(page).toContain(`<code>${command}</code>`);
	});
});
