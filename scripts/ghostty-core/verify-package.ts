import { readFileSync } from "node:fs";
import {
	loadPackageManifest,
	parseOptions,
	repositoryPath,
	verifyInstalledFiles,
	verifyPackageArchive,
} from "./package-format";

function main(): void {
	const options = parseOptions(process.argv.slice(2), ["--manifest", "--upstream-tarball", "--archive", "--installed-dir", "--help"]);
	if (options["--help"]) {
		console.log("bun scripts/ghostty-core/verify-package.ts --manifest <json> --upstream-tarball <tgz> [--archive <tgz>] [--installed-dir <directory>]");
		return;
	}
	for (const key of ["--manifest", "--upstream-tarball"]) {
		if (!options[key]) throw new Error(`Missing required option: ${key}`);
	}
	const manifest = loadPackageManifest(options["--manifest"]);
	const archivePath = options["--archive"] ?? repositoryPath(manifest.archivePath);
	const archive = readFileSync(archivePath);
	const verification = verifyPackageArchive(
		manifest,
		readFileSync(options["--upstream-tarball"]),
		readFileSync(repositoryPath(manifest.disposalPatch.path)),
		archive,
	);
	if (options["--installed-dir"]) verifyInstalledFiles(options["--installed-dir"], archive);
	console.log(JSON.stringify({ archivePath, installedVerified: Boolean(options["--installed-dir"]), ...verification }, null, 2));
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(`[ghostty-package] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
