import { describe, expect, it } from "vitest";
import { collectMediaReport, MEDIA_PRUNE_MIN_BYTES, pruneMedia, type MediaScanDeps } from "../commands/doctor-media";
import type { MediaFileStat } from "../commands/doctor-worktrees";
import { projectStorageKey } from "../../shared/project-storage-key";

const HOME = "/home/tester/.dev3.0";
const REPO = "/src/repoA";
const SLUG = projectStorageKey(REPO);
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const POOL = `${HOME}/worktrees/${SLUG}`;

const OPEN_ARTIFACT = `${POOL}/shared-artifacts/open-art`;
const TASKS = [
	{
		id: "aaaaaaaa-0000-0000-0000-000000000000",
		status: "review-by-user",
		description: `look at ${POOL}/uploads/held-upload.mp4`,
		sharedVideos: [{ storedPath: `${POOL}/shared-images/held-clip.mp4` }],
		sharedArtifacts: [{ storedPath: `${OPEN_ARTIFACT}/index.html` }],
	},
	{
		id: "bbbbbbbb-0000-0000-0000-000000000000",
		status: "completed",
		sharedVideos: [{ storedPath: `${POOL}/shared-images/old-clip.mp4` }],
	},
];

function file(path: string, mb: number, ageDays: number): MediaFileStat {
	return { path, bytes: mb * MB, changedMs: NOW - ageDays * DAY };
}

const FILES: Record<string, MediaFileStat[]> = {
	[`${POOL}/shared-images`]: [
		file(`${POOL}/shared-images/old-clip.mp4`, 40, 90),
		file(`${POOL}/shared-images/held-clip.mp4`, 40, 90),
		file(`${POOL}/shared-images/fresh-clip.mp4`, 40, 10),
		file(`${POOL}/shared-images/small-shot.png`, 4, 90),
		file(`${POOL}/shared-images/big-shot.png`, 6, 90),
	],
	[`${POOL}/shared-artifacts`]: [
		file(`${POOL}/shared-artifacts/old-art/demo.mp4`, 12, 70),
		file(`${POOL}/shared-artifacts/old-art/report.zip`, 13, 70),
		file(`${POOL}/shared-artifacts/old-art/app.js`, 9, 70),
		file(`${OPEN_ARTIFACT}/demo.mp4`, 12, 70),
		file(`${POOL}/shared-artifacts/month-art/demo.mp4`, 12, 40),
		file(`${POOL}/shared-artifacts/month-art/report.zip`, 13, 40),
	],
	[`${POOL}/uploads`]: [file(`${POOL}/uploads/held-upload.mp4`, 20, 90), file(`${POOL}/uploads/stale-upload.mov`, 20, 90)],
};

function deps(removed: string[] = []): MediaScanDeps {
	const dirs = new Set([`${HOME}/worktrees`, ...Object.keys(FILES)]);
	return {
		dev3Home: HOME,
		now: NOW,
		listDirs: (dir) => (dir === `${HOME}/worktrees` ? [SLUG] : []),
		exists: (path) => dirs.has(path),
		readFile: (path) => {
			if (path === `${HOME}/projects.json`) return JSON.stringify([{ id: "p1", name: "repoA", path: REPO }]);
			if (path === `${HOME}/data/${SLUG}/tasks.json`) return JSON.stringify(TASKS);
			throw new Error(`ENOENT: ${path}`);
		},
		walkFiles: (dir) => FILES[dir] ?? [],
		remove: (path) => {
			removed.push(path);
		},
	};
}

const name = (path: string) => path.slice(POOL.length + 1);

describe("collectMediaReport", () => {
	const report = collectMediaReport(deps());

	it("lists only images, videos and artifact ZIPs at or over 5 MB", () => {
		expect(MEDIA_PRUNE_MIN_BYTES).toBe(5 * MB);
		const names = report.entries.map((e) => name(e.path));
		expect(names).not.toContain("shared-images/small-shot.png");
		expect(names).not.toContain("shared-artifacts/old-art/app.js");
		expect(names).toContain("shared-images/big-shot.png");
		expect(report.entries.find((e) => e.path.endsWith("report.zip"))?.kind).toBe("bundle");
	});

	it("marks media an open task still shows — its clips, its artifact dirs, uploads its description names", () => {
		const held = report.entries.filter((e) => e.heldByOpenTask).map((e) => name(e.path)).sort();
		expect(held).toEqual(["shared-artifacts/open-art/demo.mp4", "shared-images/held-clip.mp4", "uploads/held-upload.mp4"]);
	});
});

describe("pruneMedia", () => {
	it("deletes old large media no open task holds, and nothing younger", () => {
		const removed: string[] = [];
		const outcomes = pruneMedia(collectMediaReport(deps()), { mediaDays: 60, bundleDays: 30 }, deps(removed));
		expect(removed.map(name).sort()).toEqual([
			"shared-artifacts/month-art/report.zip",
			"shared-artifacts/old-art/demo.mp4",
			"shared-artifacts/old-art/report.zip",
			"shared-images/big-shot.png",
			"shared-images/old-clip.mp4",
			"uploads/stale-upload.mov",
		]);
		expect(outcomes.every((o) => o.action === "removed")).toBe(true);
	});

	it("gives stored ZIPs their own age and leaves a kind alone when its age is null", () => {
		const report = collectMediaReport(deps());
		const bundlesOnly: string[] = [];
		pruneMedia(report, { mediaDays: null, bundleDays: 30 }, deps(bundlesOnly));
		expect(bundlesOnly.map(name).sort()).toEqual(["shared-artifacts/month-art/report.zip", "shared-artifacts/old-art/report.zip"]);
		const mediaOnly: string[] = [];
		pruneMedia(report, { mediaDays: 60, bundleDays: null }, deps(mediaOnly));
		expect(mediaOnly.some((p) => p.endsWith(".zip"))).toBe(false);
	});

	it("reports a failed delete instead of claiming the bytes", () => {
		const failing = { remove: () => { throw new Error("EPERM"); } };
		const outcomes = pruneMedia(collectMediaReport(deps()), { mediaDays: 60, bundleDays: 30 }, failing);
		expect(outcomes.length).toBeGreaterThan(0);
		expect(outcomes.every((o) => o.action === "failed" && o.freedBytes === 0)).toBe(true);
	});
});
