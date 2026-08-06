/**
 * The update manifest must be the LAST thing any workflow puts in the release bucket root.
 *
 * `{channel}-{os}-{arch}-update.json` is the only file clients discover a build through, so
 * publishing it before the tarball it names advertises a download that is not there yet. One
 * `aws s3 sync` of the whole artifact directory did exactly that: measured on the v1.42.0
 * release (run 31091740061, attempt 1), the manifest went first on 4 of 4 platforms, leaving a
 * 2.25–2.99s window per platform.
 *
 * This is enumerated across the WHOLE workflow directory rather than read from named files,
 * because it is a property every publisher must hold — the next publisher is the hourly
 * unstable one, and it must not be able to reintroduce this by writing its own sync.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows");

/** The bucket root is the path the in-app updater polls; a versioned prefix is an archive. */
const ROOT_SYNC = /aws s3 sync[^\n]*"s3:\/\/h0x91b-releases\/dev-3\.0\/"/;

function workflows(): { name: string; body: string }[] {
	return readdirSync(WORKFLOW_DIR)
		.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
		.map((name) => ({ name, body: readFileSync(join(WORKFLOW_DIR, name), "utf8") }));
}

const rootPublishers = workflows().filter((wf) => ROOT_SYNC.test(wf.body));

describe("publishing to the release bucket root", () => {
	it("finds something to check at all", () => {
		// A detector that matches nothing passes every assertion below on an empty set. This
		// project has already shipped one of those; see decisions/2026/08/06/extract-reusable-release-build-workflows.md
		expect(
			rootPublishers.map((wf) => wf.name),
			"no workflow was found syncing to the bucket root. Either the publishers moved, or the path/quoting this regex depends on changed — either way the ordering assertions below are now vacuous. Fix: update ROOT_SYNC to match the real publish command.",
		).not.toHaveLength(0);
	});

	for (const wf of rootPublishers) {
		it(`${wf.name} keeps the manifest out of the bulk root sync`, () => {
			const sync = wf.body.match(new RegExp(`${ROOT_SYNC.source}[^]*?(?=\\n\\n|\\n      - )`))?.[0] ?? "";
			expect(
				sync,
				`${wf.name} syncs the artifact directory to the bucket root WITHOUT excluding *-update.json, so the manifest is uploaded in the same pass as the payload it names — measured to go FIRST, every time. A client polling in that window is offered a build whose tarball 404s. Fix: add --exclude "*-update.json" and copy the manifest in a separate command afterwards.`,
			).toContain('--exclude "*-update.json"');
		});

		it(`${wf.name} copies the manifest AFTER the payload sync, not before`, () => {
			const syncAt = wf.body.search(ROOT_SYNC);
			const manifestAt = wf.body.search(/aws s3 cp[^\n]*update\.json/);
			expect(
				manifestAt,
				`${wf.name} excludes the manifest from the root sync but never uploads it separately, so no manifest reaches the feed at all and the release is invisible to every client. Fix: add the \`aws s3 cp ... -update.json\` command after the sync.`,
			).toBeGreaterThan(-1);
			expect(
				manifestAt,
				`${wf.name} uploads the manifest BEFORE the payload sync, which is the original defect with extra steps. The manifest must be the last thing written to the bucket root. Fix: move the \`aws s3 cp\` below the \`aws s3 sync\`.`,
			).toBeGreaterThan(syncAt);
		});
	}
});
