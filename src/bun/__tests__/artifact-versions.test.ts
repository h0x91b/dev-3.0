import { describe, expect, it } from "vitest";
import type { SharedArtifact } from "../../shared/types";
import {
	MAX_ARTIFACT_VERSIONS,
	appendArtifactVersion,
	artifactAtVersion,
	artifactGroupKey,
	artifactVersions,
	droppedArtifactVersions,
	latestArtifactVersion,
	recordGroupKey,
} from "../../shared/artifact-versions";

function publish(overrides: Partial<SharedArtifact> = {}): SharedArtifact {
	const id = overrides.id ?? "fresh";
	return {
		id,
		groupKey: overrides.groupKey ?? artifactGroupKey({ title: overrides.title ?? "Report" }),
		version: 1,
		isUnread: true,
		kind: "html",
		title: "Report",
		name: "report.html",
		storedPath: `/home/.dev3.0/worktrees/p/shared-artifacts/${id}/report.html`,
		originalPath: "/tmp/report.html",
		bytes: 100,
		createdAt: 1_000,
		assets: [],
		...overrides,
	};
}

describe("artifactGroupKey", () => {
	it("normalizes the title and prefers an explicit slug", () => {
		expect(artifactGroupKey({ title: "  Weekly   Report " })).toBe("title:weekly report");
		expect(artifactGroupKey({ title: "Weekly Report" })).toBe(artifactGroupKey({ title: "weekly report" }));
		expect(artifactGroupKey({ artifactId: "Weekly", title: "Weekly Report" })).toBe("id:weekly");
	});

	it("groups a legacy record with no key by its title", () => {
		const legacy = publish({ id: "legacy", groupKey: undefined, version: undefined, title: "Weekly Report" });
		expect(recordGroupKey(legacy)).toBe("title:weekly report");
		expect(latestArtifactVersion(legacy)).toBe(1);
		expect(artifactVersions(legacy)).toHaveLength(1);
	});
});

describe("appendArtifactVersion", () => {
	it("adds a version to the existing row instead of a new row", () => {
		const first = publish({ id: "a", createdAt: 1 });
		const second = publish({ id: "b", createdAt: 2, bytes: 200, name: "report2.html" });
		const { artifacts, pruned } = appendArtifactVersion([first], second);

		expect(artifacts).toHaveLength(1);
		expect(pruned).toEqual([]);
		const merged = artifacts[0];
		// The row keeps its original identity so it does not move or lose its place.
		expect(merged.id).toBe("a");
		expect(merged.version).toBe(2);
		expect(merged.isUnread).toBe(true);
		// Top-level fields describe the NEWEST version — this is what keeps every
		// existing reader working without knowing versions exist.
		expect(merged.name).toBe("report2.html");
		expect(merged.bytes).toBe(200);
		expect(merged.previousVersions?.map((entry) => entry.storedPath)).toEqual([first.storedPath]);
	});

	it("keeps a differently titled artifact as its own row", () => {
		const { artifacts } = appendArtifactVersion([publish({ id: "a" })], publish({ id: "b", title: "Other", groupKey: artifactGroupKey({ title: "Other" }) }));
		expect(artifacts.map((artifact) => artifact.id)).toEqual(["a", "b"]);
	});

	it("collapses pre-versioning records that share a title, oldest first", () => {
		const legacy = [1, 2, 3].map((n) => publish({ id: `legacy-${n}`, groupKey: undefined, version: undefined, createdAt: n }));
		const { artifacts, pruned } = appendArtifactVersion(legacy, publish({ id: "new", createdAt: 9 }));

		expect(artifacts).toHaveLength(1);
		expect(pruned).toEqual([]);
		expect(artifacts[0].id).toBe("legacy-1");
		expect(artifacts[0].version).toBe(4);
		// Renumbered 1..N: every legacy record claimed version 1 on its own.
		expect(artifactVersions(artifacts[0]).map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
		expect(artifactVersions(artifacts[0]).map((entry) => entry.createdAt)).toEqual([1, 2, 3, 9]);
	});

	it("is re-runnable: collapsing again only appends", () => {
		const once = appendArtifactVersion([publish({ id: "a", createdAt: 1 })], publish({ id: "b", createdAt: 2 })).artifacts;
		const twice = appendArtifactVersion(once, publish({ id: "c", createdAt: 3 })).artifacts;
		expect(twice).toHaveLength(1);
		expect(twice[0].id).toBe("a");
		expect(artifactVersions(twice[0]).map((entry) => entry.createdAt)).toEqual([1, 2, 3]);
	});

	it("never attaches to a --new artifact, and later publishes group with each other", () => {
		const standalone = publish({ id: "forced", groupKey: "new:forced" });
		const first = appendArtifactVersion([standalone], publish({ id: "a" }));
		expect(first.artifacts.map((artifact) => artifact.id)).toEqual(["forced", "a"]);
		const second = appendArtifactVersion(first.artifacts, publish({ id: "b" }));
		expect(second.artifacts.map((artifact) => artifact.id)).toEqual(["forced", "a"]);
		expect(second.artifacts[1].version).toBe(2);
	});

	it("trims to the cap and reports what dropped without touching stored files", () => {
		let artifacts: SharedArtifact[] = [];
		let pruned: ReturnType<typeof appendArtifactVersion>["pruned"] = [];
		for (let n = 1; n <= MAX_ARTIFACT_VERSIONS + 3; n++) {
			const result = appendArtifactVersion(artifacts, publish({ id: `v${n}`, createdAt: n }));
			artifacts = result.artifacts;
			pruned = result.pruned;
		}
		const merged = artifacts[0];
		expect(merged.version).toBe(MAX_ARTIFACT_VERSIONS + 3);
		expect(artifactVersions(merged)).toHaveLength(MAX_ARTIFACT_VERSIONS);
		expect(droppedArtifactVersions(merged)).toBe(3);
		// The oldest retained version is the cap'th from the end. Once the cap is
		// reached each publish prunes exactly one version — returned to the caller so
		// it can be reported, never deleted from disk.
		expect(artifactVersions(merged)[0].version).toBe(4);
		expect(pruned.map((entry) => entry.version)).toEqual([3]);
	});
});

describe("artifactAtVersion", () => {
	it("projects an older version and lets nothing from the newer one leak through", () => {
		const withAssets = publish({
			id: "a",
			createdAt: 1,
			assets: [{ name: "app.css", storedPath: "/s/a/app.css", originalPath: "/tmp/app.css", mime: "text/css", bytes: 4 }],
			bundlePath: "/s/a/report.zip",
			bundleBytes: 40,
		});
		const plain = publish({ id: "b", createdAt: 2, name: "later.html" });
		const merged = appendArtifactVersion([withAssets], plain).artifacts[0];

		expect(artifactAtVersion(merged, 2)).toBe(merged);
		const old = artifactAtVersion(merged, 1);
		expect(old.name).toBe("report.html");
		expect(old.createdAt).toBe(1);
		expect(old.assets.map((asset) => asset.name)).toEqual(["app.css"]);
		expect(old.bundlePath).toBe("/s/a/report.zip");
		expect(old.previousVersions).toBeUndefined();
		// The newest version has no bundle — projecting back must not inherit one.
		expect(artifactAtVersion(merged, 2).bundlePath).toBeUndefined();
	});

	it("falls back to the record for an unknown version", () => {
		const only = publish({ id: "a" });
		expect(artifactAtVersion(only, 7)).toBe(only);
	});
});
