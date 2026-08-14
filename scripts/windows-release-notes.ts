/**
 * The prose that travels with a Windows download — one copy, two destinations.
 *
 * The unsigned warning is part of the deliverable, not a footnote: a first-time user who meets
 * an unexplained full-screen "Windows protected your PC" dialog concludes the app is malware and
 * never comes back. So the same paragraph has to reach BOTH readers — the CI run summary
 * (canary, `windows-app-archive` job) and the GitHub Release body (stable) — and it lives here
 * once, because two copies drift and the one that drifts is always the one nobody is reading.
 *
 * EVERY VALUE IS PASSED IN, NOTHING IS RECOMPUTED. The bundle root and the entry point come out
 * of `windows-app-launch-proof.json` at the call site, which is what stops this text from naming
 * an executable no proof ever started — the property
 * decisions/2026/08/06/downloadable-windows-build-is-the-launched-tree.md exists to keep.
 */

export interface WindowsDownloadFacts {
	/** Published file name, e.g. `stable-win-x64-dev-3.0.zip`. */
	zipName: string;
	/** Full URL the file will be downloadable from. */
	zipUrl: string;
	zipBytes: number;
	/** The zip's single top-level folder, e.g. `dev-3.0` or `dev-3.0-canary`. */
	bundleRoot: string;
	/** Entry point relative to `bundleRoot`, POSIX-separated as the proof records it. */
	launcherRelative: string;
	/** stable or canary — names the build, never the instructions. */
	channel: string;
}

/**
 * MEASURED on a real ru-RU Windows x64 machine (artifact `windows-app-068ea95df…`, run
 * 31781800859): the buttons were «Подробнее» then «Всё равно запустить» — two clicks — and the
 * app ran normally afterwards, board rendered, an agent ran over PowerShell.
 *
 * The dialog's TITLE is deliberately not quoted: it is localised and the en-US one has never
 * been read. Quoting the English line on a machine showing Russian is worse than describing it.
 */
export const WINDOWS_UNSIGNED_WARNING =
	"**This build is not code-signed, and it never will be.** The first time you run it, Windows " +
	"covers the screen with a blue SmartScreen warning. Getting past it is two clicks: **More info**, " +
	"then **Run anyway** — once per build. That dialog means Windows does not recognise the " +
	"publisher. It is not a virus report.";

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `bin/launcher.exe` reads as a path a Windows user can follow only with backslashes. */
const windowsPath = (posixRelative: string) => posixRelative.split("/").join("\\");

/**
 * The block appended to the GitHub Release body under `## Download`. Rendered by the Windows
 * build job and carried to `release.yml` as an artifact, so the release notes cannot describe a
 * Windows build the release does not contain.
 */
export function renderWindowsReleaseNotes(facts: WindowsDownloadFacts): string {
	return [
		"### Windows (x64) — unsigned, and there is no installer yet",
		"",
		`- [\`${facts.zipName}\`](${facts.zipUrl}) (${megabytes(facts.zipBytes)})`,
		"",
		`Extract the zip (right-click → **Extract All**; nothing else needed), open the \`${facts.bundleRoot}\` folder and double-click \`${windowsPath(facts.launcherRelative)}\`.`,
		"",
		WINDOWS_UNSIGNED_WARNING,
		"",
	].join("\n");
}

/** The same facts as a CI run summary, for the channel that publishes straight to a bucket. */
export function renderWindowsRunSummary(facts: WindowsDownloadFacts): string {
	return [
		"",
		`## Windows build (${facts.channel})`,
		"",
		`**Download:** ${facts.zipUrl} (${megabytes(facts.zipBytes)})`,
		"",
		"1. Download the `.zip`, right-click it → **Extract All**. No other tool is needed.",
		`2. Open the extracted \`${facts.bundleRoot}\` folder and double-click \`${windowsPath(facts.launcherRelative)}\`.`,
		`3. ${WINDOWS_UNSIGNED_WARNING}`,
		"",
		`These are the exact bytes the launch proof spawned in this run — bundle root \`${facts.bundleRoot}\`, entry point \`${facts.launcherRelative}\`.`,
		"",
	].join("\n");
}
