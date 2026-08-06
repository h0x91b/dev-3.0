/**
 * The run summary that hands a packaged Windows build to a human.
 *
 * The property under test is not formatting: it is that the executable the summary
 * advertises comes out of the proof that launched it. Windows is the only platform with
 * no local machine in the loop, so a summary pointing at an unproven binary is the exact
 * failure this whole path exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { windowsDownloadSummary } from "../../../scripts/windows-download-summary";

const PROOF = {
	bundleRoot: "dev-3.0-canary",
	retainedUnpackDir: "windows-app-unpacked",
	desktopExecutableRelativePath: "bin/launcher.exe",
	readyAfterMs: 4321,
};

const INPUTS = {
	artifactName: "windows-app-abc1234",
	commitSha: "abc1234",
	builtAt: "2026-08-06T10:55:00.000Z",
	retentionDays: 30,
};

describe("the downloadable Windows build's run summary", () => {
	it("names the executable the proof launched, in Windows form", () => {
		const summary = windowsDownloadSummary(PROOF, INPUTS);
		expect(summary).toContain("dev-3.0-canary");
		expect(summary).toContain("bin\\launcher.exe");
		expect(summary).not.toContain("bin/launcher.exe");
	});

	it("identifies the build after the run page is gone", () => {
		const summary = windowsDownloadSummary(PROOF, INPUTS);
		expect(summary).toContain("windows-app-abc1234");
		expect(summary).toContain("abc1234");
		expect(summary).toContain("2026-08-06T10:55:00.000Z");
	});

	it("states the retention and that an expired build is re-run, not lost", () => {
		const summary = windowsDownloadSummary(PROOF, INPUTS);
		expect(summary).toContain("30 days");
		expect(summary).toMatch(/re-run this workflow on the same commit/);
	});

	it("warns about SmartScreen and the missing signature before the download happens", () => {
		const summary = windowsDownloadSummary(PROOF, INPUTS);
		expect(summary).toContain("SmartScreen");
		expect(summary).toContain("Run anyway");
		expect(summary).toContain("Unknown publisher");
	});

	it("survives a proof written without a ready duration", () => {
		const summary = windowsDownloadSummary({ ...PROOF, readyAfterMs: undefined }, INPUTS);
		expect(summary).toContain("ready marker");
		expect(summary, "a missing duration must drop the clause, not render as a placeholder").not.toMatch(
			/undefined|null/,
		);
	});

	// The three below are the binding itself. Each message must name the cause and the
	// fix, because from the outside a broken binding reads as a formatting bug.
	it("refuses to invent an entry point the proof never recorded", () => {
		expect(() => windowsDownloadSummary({ ...PROOF, desktopExecutableRelativePath: undefined }, INPUTS))
			.toThrow(/desktopExecutableRelativePath[\s\S]*CAUSE[\s\S]*FIX/);
	});

	it("refuses to name a folder the proof never recorded", () => {
		expect(() => windowsDownloadSummary({ ...PROOF, bundleRoot: "" }, INPUTS))
			.toThrow(/bundleRoot[\s\S]*CAUSE[\s\S]*FIX/);
	});

	it("refuses to advertise bytes the proof deleted with its temp workspace", () => {
		expect(() => windowsDownloadSummary({ ...PROOF, retainedUnpackDir: null }, INPUTS))
			.toThrow(/DEV3_WINDOWS_APP_UNPACK_DIR/);
	});
});
