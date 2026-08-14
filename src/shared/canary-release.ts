/**
 * The canary channel's HUMAN-FACING download surface: one rolling GitHub pre-release.
 *
 * NOT A SECOND UPDATE FEED. The in-app updater reads `s3://h0x91b-releases/dev-3.0/` and
 * orders builds by `buildOrder` in the manifest; nothing here is ever fetched by the app.
 * This exists because a person who wants to shake out a canary build had no page to visit
 * and had to be handed a raw bucket URL.
 *
 * ONE ROLLING ENTRY, not one release per publish. Measured on 145 runs of the hourly
 * publisher: 4.2 publishes a day (peak 9), because the `decide` job skips every platform on
 * an hour when main has not moved. A release per publish is ~30 entries a week, which buries
 * every stable release. Per-day (`canary-YYYY-MM-DD`) is the documented fallback if the
 * history is ever wanted. See decisions/2026/08/14/canary-rolling-github-prerelease.md.
 *
 * WHY COPIES AND NOT BUCKET LINKS: the canary keys at the bucket ROOT are overwritten in
 * place by the next publish, so a link would silently change bytes under whoever downloads
 * it. A release asset is fixed bytes, and the ledger below says which run produced each one.
 */

import { CANARY_PLATFORMS } from "./canary-publish";

/**
 * The tag the rolling release carries, moved to the newest published commit on every run.
 *
 * IT MUST NEVER MATCH release.yml's TAG FILTERS (`v*`, `test-*`). If it did, every canary
 * publish would push a tag that starts a full stable release: signed DMGs, the stable feed,
 * and a Homebrew cask edit pointing at a canary build. `canary-release.test.ts` pins this
 * against the filters read out of release.yml itself, not against a copy of them.
 */
export const CANARY_RELEASE_TAG = "canary";

/** The ledger's own file name, attached to the release next to the builds it describes. */
export const CANARY_LEDGER_ASSET = "canary-assets.json";

/**
 * One downloadable file and the run that produced it.
 *
 * THE RUN, NOT THE SHA, IS THE IDENTITY. Windows trees are not byte-reproducible — one sha
 * built three times gave three different zips (15-byte spread) — so "the build at 42ee05e8"
 * does not name a specific file, and only the run id does.
 */
export type CanaryAssetEntry = {
	/** File name as attached to the release. */
	asset: string;
	/** `os-arch` from {@link CANARY_PLATFORMS}, or `other` for the platform-agnostic CLI tarballs. */
	platform: string;
	/** Full commit the run built. */
	sha: string;
	/** GitHub Actions run id — the only thing that names these exact bytes. */
	runId: string;
	/** When the run attached it, ISO 8601. */
	builtAt: string;
};

export type CanaryLedger = { assets: CanaryAssetEntry[] };

/**
 * Whether an artifact from a canary build belongs on the release page.
 *
 * A REJECTION IS A SENTENCE, not a boolean, because every one of these has burned someone:
 * the installer nothing has ever launched, and a manifest that would read as a second feed.
 */
export type ArtifactVerdict = { upload: true } | { upload: false; reason: string };

export function classifyCanaryArtifact(name: string): ArtifactVerdict {
	if (name === CANARY_LEDGER_ASSET) {
		return { upload: false, reason: "the ledger itself — attached separately, after it is merged" };
	}
	if (name.endsWith("-update.json")) {
		return {
			upload: false,
			reason:
				"an update manifest. The app discovers builds through the S3 feed only; a copy on the release page is a second feed that goes stale the moment the next build publishes.",
		};
	}
	if (name.endsWith(".md")) {
		return { upload: false, reason: "prose a build job hands to the release body, not a published file" };
	}
	if (/Setup/.test(name)) {
		return {
			upload: false,
			reason:
				"the self-extracting Windows installer. Nothing has ever launched it — the launch proof spawns the tree inside the zip — so handing it out would put the unvetted binary in front of users while the proven one stayed decoration.",
		};
	}
	if (/^.*win-.*\.tar\.zst$/.test(name)) {
		return {
			upload: false,
			reason:
				"the Windows updater's own download. Windows tar.exe cannot read zstd, so a human cannot open it; the zip is the file for people.",
		};
	}
	return { upload: true };
}

/**
 * `os-arch` for a file name, or `other` when no platform token appears in it.
 *
 * The CLI tarballs carry the SAME `os-arch` token as the app build for that platform, so
 * without the `cli-` prefix the table shows two rows labelled `macos-arm64` and the reader has
 * to know which file is the app.
 */
export function platformOfArtifact(name: string): string {
	const prefix = name.startsWith("dev3-cli-") ? "cli-" : "";
	for (const { os, arch } of CANARY_PLATFORMS) {
		if (name.includes(`${os}-${arch}`)) return `${prefix}${os}-${arch}`;
	}
	return prefix ? "cli" : "other";
}

/**
 * Folds this run's uploads into what the release already carries.
 *
 * THE MERGE IS THE POINT. A canary run rebuilds only the platforms whose own feed is behind,
 * so a release can legitimately hold a Windows zip from one commit next to a DMG from an
 * older one. Dropping the previous entries would make the body claim every asset came from
 * this run; keeping them unmerged would show two rows for one file.
 */
export function mergeCanaryLedger(previous: CanaryLedger | null, fresh: CanaryAssetEntry[]): CanaryLedger {
	const byAsset = new Map<string, CanaryAssetEntry>();
	for (const entry of previous?.assets ?? []) byAsset.set(entry.asset, entry);
	for (const entry of fresh) byAsset.set(entry.asset, entry);
	return { assets: [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset)) };
}

/** Parses a ledger read back off the release, tolerating anything that is not one. */
export function parseCanaryLedger(raw: string): CanaryLedger | null {
	try {
		const parsed = JSON.parse(raw) as { assets?: unknown };
		if (!Array.isArray(parsed.assets)) return null;
		const assets = parsed.assets.filter(
			(entry): entry is CanaryAssetEntry =>
				!!entry && typeof (entry as CanaryAssetEntry).asset === "string" && typeof (entry as CanaryAssetEntry).sha === "string",
		);
		return { assets };
	} catch {
		return null;
	}
}

export type CanaryBodyInput = {
	ledger: CanaryLedger;
	/** Version string out of this run's manifest, e.g. `1.44.0+canary.42ee05e8`. */
	version: string;
	/** `https://github.com/<owner>/<repo>` — every run link is built off it. */
	repoUrl: string;
	/** When this body was rendered, ISO 8601. */
	generatedAt: string;
};

/**
 * The release body. Written so the FIRST paragraph is the whole warning, because the release
 * page shows the beginning of the body under the title and that preview is all most people
 * read before clicking a download.
 */
export function renderCanaryReleaseBody({ ledger, version, repoUrl, generatedAt }: CanaryBodyInput): string {
	const rows = ledger.assets
		.filter((entry) => entry.asset !== CANARY_LEDGER_ASSET)
		.map((entry) => {
			const url = `${repoUrl}/releases/download/${CANARY_RELEASE_TAG}/${entry.asset}`;
			const run = `[${entry.runId}](${repoUrl}/actions/runs/${entry.runId})`;
			return `| ${entry.platform} | [\`${entry.asset}\`](${url}) | \`${entry.sha.slice(0, 9)}\` | ${run} | ${entry.builtAt} |`;
		});

	return [
		`# Canary ${version}`,
		"",
		"**This is not the release you want unless you came here to test one.** It is built from",
		"`main` automatically, it is unsigned on Windows, and it is replaced in place every time",
		`main moves — the [Latest release](${repoUrl}/releases/latest) is the stable download.`,
		"",
		"## Downloads",
		"",
		"| Platform | File | Built from | Run | Attached |",
		"| --- | --- | --- | --- | --- |",
		...(rows.length > 0 ? rows : ["| — | _no assets attached yet_ | — | — | — |"]),
		"",
		"Each row names the RUN that produced those exact bytes, not just the commit: Windows",
		"trees are not byte-reproducible, and a run only rebuilds the platforms whose feed is",
		"behind, so rows can legitimately come from different commits.",
		"",
		"### Windows",
		"",
		"The zip is the tree a CI job actually launched and shut down cleanly. It is **unsigned**,",
		"so the first launch shows SmartScreen's warning — that is the missing certificate, not a",
		"malware verdict. Extract it with Explorer and run the executable inside; there is nothing",
		"to install.",
		"",
		"### Sent here by the app's own refusal?",
		"",
		"Switching stable → canary in place only works on macOS: everywhere else the running app",
		"IS the channel folder, so an in-place switch would install into a directory the launcher",
		"never starts, and the updater refuses instead of silently doing nothing. Its message says",
		"to install the other channel's build from the releases page — that is this page, and the",
		"file is the one on the `win-x64` row above. Once it is running, canary updates itself",
		"inside the canary channel on macOS and Linux; on Windows in-place updating is not reliable",
		"yet, so download the `win-x64` zip from this page again to move to a newer canary.",
		"",
		"## Updates do not come from this page",
		"",
		"The in-app updater reads the canary feed in S3 and orders builds by `buildOrder`, never by",
		"a version string or a GitHub release. This page is a download surface for people; deleting",
		"it would not affect a single client.",
		"",
		`<sub>Rendered ${generatedAt} · tag \`${CANARY_RELEASE_TAG}\` is moved to the newest published commit on every publish.</sub>`,
		"",
	].join("\n");
}
