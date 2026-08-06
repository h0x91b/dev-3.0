/**
 * The run-summary section that tells a human how to run the packaged Windows build.
 *
 * It is derived FROM `windows-app-launch-proof.json` rather than written alongside it,
 * and that is the whole design: the executable this text tells someone to double-click
 * is read out of the proof that actually launched it, so the summary cannot advertise a
 * file nothing ever started. The three assertions below are what keeps that binding —
 * each fails naming the cause and the fix, because a broken binding looks exactly like a
 * cosmetic formatting bug from the outside.
 *
 * Windows is the only platform with no local machine in the loop, so this text is the
 * entire hand-off. It carries the commit and the build date because a folder already
 * extracted on someone's disk has to identify itself long after the run page scrolled
 * away.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** Only the fields the summary reads; the proof carries far more. */
export interface LaunchProof {
	bundleRoot?: unknown;
	retainedUnpackDir?: unknown;
	desktopExecutableRelativePath?: unknown;
	readyAfterMs?: unknown;
}

export interface SummaryInputs {
	/** The uploaded artifact's name, as it appears on the run page. */
	artifactName: string;
	commitSha: string;
	/** ISO timestamp of the build, rendered as-is. */
	builtAt: string;
	retentionDays: number;
}

function requireText(value: unknown, field: string, cause: string, fix: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`windows-app-launch-proof.json has no usable \`${field}\`. CAUSE: ${cause} FIX: ${fix}`,
		);
	}
	return value;
}

/** `bin/launcher.exe` reads as `bin\launcher.exe` to somebody on Windows. */
function windowsPath(posixPath: string): string {
	return posixPath.split("/").join("\\");
}

export function windowsDownloadSummary(proof: LaunchProof, inputs: SummaryInputs): string {
	const bundleRoot = requireText(
		proof.bundleRoot,
		"bundleRoot",
		"the launch proof did not record which folder the archive unpacked to, so this summary cannot name the folder a human will see after extracting.",
		"keep the `bundleRoot` field in scripts/verify-windows-app-launch.ts, or teach this script the field that replaced it.",
	);
	const launcher = requireText(
		proof.desktopExecutableRelativePath,
		"desktopExecutableRelativePath",
		"the launch proof did not record which executable it started, and this summary refuses to invent an entry point — the whole point is that the file it advertises is the file that was launched.",
		"keep the `desktopExecutableRelativePath` field in scripts/verify-windows-app-launch.ts.",
	);
	// The binding that makes the advertised bytes the launched bytes. Without a retained
	// directory the proof deleted its extraction with its temp workspace, and any tree
	// the upload step found would be a look-alike nobody ever started.
	requireText(
		proof.retainedUnpackDir,
		"retainedUnpackDir",
		"the launch proof extracted into a temporary workspace and deleted it, so the bytes it launched no longer exist and nothing can be uploaded that this proof covers.",
		"set DEV3_WINDOWS_APP_UNPACK_DIR on the `Launch the packaged Windows app` step to the same directory the upload step publishes.",
	);
	const readyAfterMs = typeof proof.readyAfterMs === "number" ? proof.readyAfterMs : null;

	return [
		"## 🪟 Windows build you can download and run",
		"",
		`**Artifact:** \`${inputs.artifactName}\` · commit \`${inputs.commitSha}\` · built ${inputs.builtAt}`,
		"",
		"These are the exact bytes this run launched: CI extracted this tree, started it, waited",
		readyAfterMs === null
			? "for the app's ready marker, and shut it down cleanly."
			: `for the app's ready marker (reached in ${readyAfterMs} ms), and shut it down cleanly.`,
		"Nothing was rebuilt or repacked for you afterwards.",
		"",
		"### How to run it",
		"",
		`1. Download **\`${inputs.artifactName}\`** from the Artifacts section of this run page. GitHub hands it to you as a \`.zip\`.`,
		"2. Right-click the `.zip` → **Extract All**. No other tool is needed.",
		`3. Open the \`${bundleRoot}\` folder and double-click **\`${windowsPath(launcher)}\`**.`,
		"",
		"### It is not code-signed — Windows will say so",
		"",
		"dev-3.0 has no Windows Authenticode signature yet, and a file downloaded through a browser",
		"carries a mark that tells Windows where it came from. Expect this, in this order:",
		"",
		"- **“Windows protected your PC”** (SmartScreen), showing only a **Don't run** button. Click **More info**, then **Run anyway**.",
		"- The publisher shows as **Unknown publisher**. That is accurate — there is no certificate to name one.",
		"- Microsoft Defender may scan the folder on first launch, which makes the first start noticeably slower.",
		"",
		"None of that indicates a problem with the build; it is what an unsigned application looks like on Windows.",
		"",
		"### Availability",
		"",
		`This artifact is kept for **${inputs.retentionDays} days**, not the 90-day default — a months-old build sitting in the`,
		"artifact list is a build somebody downloads believing it is current. After it expires the build is not",
		"lost: re-run this workflow on the same commit and it is rebuilt from scratch.",
		"",
	].join("\n");
}

if (import.meta.main) {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const proofPath = join(repoRoot, "artifacts", "windows-app-launch-proof.json");
	const proof = JSON.parse(readFileSync(proofPath, "utf8")) as LaunchProof;
	const summary = windowsDownloadSummary(proof, {
		artifactName: process.env.DEV3_WINDOWS_ARTIFACT_NAME ?? "windows-app",
		commitSha: process.env.GITHUB_SHA ?? "unknown",
		builtAt: new Date().toISOString(),
		retentionDays: Number(process.env.DEV3_WINDOWS_ARTIFACT_RETENTION_DAYS ?? 30),
	});
	const target = process.env.GITHUB_STEP_SUMMARY;
	if (target) writeFileSync(target, summary, { flag: "a" });
	console.log(summary);
}
