import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	createPackageFiles,
	loadPackageManifest,
	parseOptions,
	repositoryPath,
	verifyPackageArchive,
	writePackageArchive,
} from "./package-format";

function main(): void {
	const options = parseOptions(process.argv.slice(2), ["--manifest", "--upstream-tarball", "--wasm", "--output", "--help"]);
	if (options["--help"]) {
		console.log("bun scripts/ghostty-core/package.ts --manifest <json> --upstream-tarball <tgz> --wasm <wasm> [--output <tgz>]");
		return;
	}
	for (const key of ["--manifest", "--upstream-tarball", "--wasm"]) {
		if (!options[key]) throw new Error(`Missing required option: ${key}`);
	}
	const manifest = loadPackageManifest(options["--manifest"]);
	const patchPath = repositoryPath(manifest.disposalPatch.path);
	const outputPath = options["--output"] ? resolve(options["--output"]) : repositoryPath(manifest.archivePath);
	for (const input of [options["--manifest"], options["--upstream-tarball"], options["--wasm"], patchPath]) {
		if (resolve(input) === outputPath) throw new Error("Package output must not overwrite an input");
	}
	const upstream = readFileSync(options["--upstream-tarball"]);
	const wasm = readFileSync(options["--wasm"]);
	const patch = readFileSync(patchPath);
	const archive = writePackageArchive(createPackageFiles(manifest, upstream, wasm, patch));
	const verification = verifyPackageArchive(manifest, upstream, patch, archive);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, archive);
	console.log(JSON.stringify({ outputPath, ...verification }, null, 2));
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(`[ghostty-package] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
