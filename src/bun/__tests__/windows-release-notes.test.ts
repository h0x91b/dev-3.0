/**
 * The Windows download's prose, asserted where it can be asserted at all.
 *
 * The script that renders it (`package-windows-launched-tree.ts`) cannot run to completion off
 * Windows — it zips through PowerShell's System.IO.Compression — so the text was untestable while
 * it lived inline. Extracted to a pure renderer, it is testable everywhere, and what these pin is
 * the part with a cost when it is wrong: the unsigned warning, and the entry point.
 *
 * Rendering is exercised on this host; the produced file is exercised by the Windows job.
 */

import { describe, expect, it } from "vitest";
import {
	renderWindowsReleaseNotes,
	renderWindowsRunSummary,
	WINDOWS_UNSIGNED_WARNING,
	type WindowsDownloadFacts,
} from "../../../scripts/windows-release-notes";

const FACTS: WindowsDownloadFacts = {
	zipName: "stable-win-x64-dev-3.0.zip",
	zipUrl: "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0/v1.45.0/stable-win-x64-dev-3.0.zip",
	zipBytes: 417_000_000,
	bundleRoot: "dev-3.0",
	launcherRelative: "bin/launcher.exe",
	channel: "stable",
};

describe("the unsigned-launch warning", () => {
	// The measured click path, not a prediction: «Подробнее» then «Всё равно запустить» on a real
	// ru-RU x64 machine (artifact windows-app-068ea95df…, run 31781800859). A user who is not told
	// what the dialog means concludes the app is malware, so this is a deliverable, not a footnote.
	it("names the two clicks that get past SmartScreen", () => {
		expect(
			WINDOWS_UNSIGNED_WARNING,
			"the warning no longer names both buttons. 'Windows will warn you' without the click path leaves the user stuck at a full-screen dialog with no visible way forward. Fix: keep **More info** → **Run anyway**.",
		).toMatch(/More info/);
		expect(WINDOWS_UNSIGNED_WARNING).toMatch(/Run anyway/);
	});

	it("says the dialog is about an unrecognised publisher, not a virus", () => {
		expect(
			WINDOWS_UNSIGNED_WARNING,
			"the warning stopped explaining what SmartScreen actually claims. That sentence is the difference between 'unsigned app' and 'my antivirus flagged this' in the reader's head. Fix: keep the publisher-vs-virus line.",
		).toMatch(/not a virus report/i);
	});

	it("states the missing signature as a present fact, not a permanent vow", () => {
		// There is no certificate today and Arseny does not want to buy one — that is the present
		// tense. "It never will be" turned a budget decision into a promise about every future build.
		expect(
			WINDOWS_UNSIGNED_WARNING,
			"the warning promises the build will never be signed. That is a vow about the future nobody made. Fix: say it is unsigned at this time and leave the future open.",
		).not.toMatch(/never will be|will never be/i);
		expect(WINDOWS_UNSIGNED_WARNING).toMatch(/at this time/i);
	});

	it("does not quote the localised dialog title", () => {
		// The title was never captured on an en-US machine — it is recorded as unknown, not absent.
		// Quoting an English title to someone whose Windows shows Russian is worse than describing it.
		expect(
			WINDOWS_UNSIGNED_WARNING,
			"the warning now quotes the dialog's title. Nobody has read the en-US one; the only observation is from a ru-RU machine, and the title was explicitly not captured. Fix: describe the dialog, do not quote it.",
		).not.toMatch(/protected your PC/i);
	});
});

describe("the release-notes fragment", () => {
	const notes = renderWindowsReleaseNotes(FACTS);

	it("carries the warning, the file and the entry point", () => {
		expect(notes, "the release body must carry the unsigned warning next to the download, not somewhere else.").toContain(
			WINDOWS_UNSIGNED_WARNING,
		);
		expect(notes).toContain(FACTS.zipUrl);
		// The real one is 121.0 MB (run 31799430704, windows-latest); the fixture is deliberately a
		// different number so a hardcoded size in the renderer would show up here.
		expect(notes, "a size lets the reader decide before starting a nine-figure download").toMatch(/397\.7 MB/);
	});

	it("writes the entry point the way Windows shows it", () => {
		expect(
			notes,
			"the launcher path is printed with POSIX separators, which is how the launch proof records it and not how a Windows user reads it. Fix: keep the backslash conversion.",
		).toContain("bin\\launcher.exe");
	});

	it("is a heading plus content, so it can be appended into the Download section", () => {
		expect(
			notes.trimStart(),
			"release.yml appends this under `## Download`, so it has to open with its own `###` heading or it merges into whatever section came before it.",
		).toMatch(/^### Windows \(x64\)/);
	});
});

describe("the CI run summary", () => {
	it("names the channel it built instead of hardcoding one", () => {
		// It said "Windows canary build" on every channel while canary was the only caller. A
		// stable run would have announced itself as canary and read as a mis-published build.
		expect(renderWindowsRunSummary(FACTS)).toContain("## Windows build (stable)");
		expect(renderWindowsRunSummary({ ...FACTS, channel: "canary" })).toContain("## Windows build (canary)");
	});

	it("carries the same warning as the release body", () => {
		expect(
			renderWindowsRunSummary(FACTS),
			"the two destinations must share one copy of the warning — a second copy drifts, and the drifted one is always the one being read.",
		).toContain(WINDOWS_UNSIGNED_WARNING);
	});
});
