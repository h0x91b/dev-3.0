import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		manifest: { type: "string", default: "patches/ghostty-web/core-manifest.json" },
		cache: { type: "string", default: "artifacts/ghostty-core-build" },
		output: { type: "string" },
		baseline: { type: "boolean", default: false },
	},
});
const repo = process.cwd();
const manifest = JSON.parse(await readFile(resolve(values.manifest), "utf8"));
const cache = resolve(values.cache);
const inputs = join(cache, "inputs");
const output = resolve(values.output ?? join(cache, "outputs", values.baseline ? "baseline.wasm" : "zeroing.wasm"));
await mkdir(inputs, { recursive: true });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function input(name: string, source: { url: string; sha256: string }): Promise<string> {
	const file = join(inputs, name);
	if (!(await Bun.file(file).exists())) {
		const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`Download failed: ${response.status} ${source.url}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (sha256(bytes) !== source.sha256) throw new Error(`Checksum mismatch: ${name}`);
		await Bun.write(file, bytes);
	}
	if (sha256(await readFile(file)) !== source.sha256) throw new Error(`Checksum mismatch: ${file}`);
	return file;
}

async function run(command: string[], cwd: string, stdin?: string): Promise<string> {
	const child = Bun.spawn(command, {
		cwd,
		stdin: stdin ? Bun.file(stdin) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const deadline = setTimeout(() => child.kill("SIGKILL"), 180_000);
	try {
		const [status, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (status !== 0) throw new Error(`${command[0]} failed (${status}):\n${stderr}\n${stdout}`);
		if (stderr) process.stderr.write(stderr);
		return stdout.trim();
	} finally {
		clearTimeout(deadline);
	}
}

const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unsupported";
const platform = process.platform === "darwin" ? "macos" : process.platform;
const toolchain = manifest.build.toolchains[`${architecture}-${platform}`];
if (!toolchain) throw new Error(`No pinned build toolchain for ${process.platform}/${process.arch}`);
const protectedInputs = [
	resolve(values.manifest),
	join(inputs, basename(new URL(toolchain.url).pathname)),
	join(inputs, `ghostty-${manifest.source.coreCommit.slice(0, 8)}.tar.gz`),
	join(inputs, "ghostty-wasm-api.patch"),
	...manifest.build.patches.map((patch: { path: string }) => resolve(patch.path)),
	resolve(manifest.package.disposalPatch.path),
	resolve(manifest.package.archivePath),
];
if ([output, `${output}.provenance.json`].some((path) => protectedInputs.includes(path))) {
	throw new Error("Build output must not overwrite an input or the packaged archive");
}
const toolArchive = await input(basename(new URL(toolchain.url).pathname), toolchain);
const coreArchive = await input(`ghostty-${manifest.source.coreCommit.slice(0, 8)}.tar.gz`, manifest.source.archive);
const apiPatch = await input("ghostty-wasm-api.patch", manifest.source.apiPatch);

// Extract pinned inputs into a fresh generated directory, never a git checkout.
const work = await mkdtemp(join(cache, "rebuild-"));
await run(["tar", "-xf", toolArchive, "-C", work], repo);
await run(["tar", "-xf", coreArchive, "-C", work], repo);
const zig = join(work, basename(toolArchive).replace(/\.tar\.xz$/, ""), "zig");
const core = join(work, `ghostty-${manifest.source.coreCommit}`);
if (await run([zig, "version"], repo) !== manifest.build.zigVersion) throw new Error("Unexpected Zig version");
await run(["patch", "-p1", "--fuzz=0", "--batch"], core, apiPatch);
if (!values.baseline) {
	for (const patch of manifest.build.patches) {
		const path = resolve(patch.path);
		if (sha256(await readFile(path)) !== patch.sha256) throw new Error(`Checksum mismatch: ${patch.path}`);
		await run(["patch", "-p1", "--fuzz=0", "--batch"], core, path);
	}
}
const buildCommand = [
	zig, "build", "lib-vt",
	`-Dtarget=${manifest.build.target}`,
	`-Doptimize=${manifest.build.optimize}`,
	`-Dversion-string=${manifest.build.versionString}`,
	"-j2", "--cache-dir", join(work, "cache"),
	"--global-cache-dir", join(cache, "zig-global-cache"), "--summary", "all",
];
await run(buildCommand, core);
const built = join(core, "zig-out/bin/ghostty-vt.wasm");
const bytes = await readFile(built);
const expected = values.baseline ? manifest.package.upstreamWasmSha256 : manifest.package.wasmSha256;
if (sha256(bytes) !== expected) throw new Error(`WASM differs from the pinned build: ${sha256(bytes)}`);
await mkdir(dirname(output), { recursive: true });
await copyFile(built, output);
await Bun.write(`${output}.provenance.json`, JSON.stringify({
	wrapperCommit: manifest.source.wrapperCommit,
	coreCommit: manifest.source.coreCommit,
	zigVersion: manifest.build.zigVersion,
	toolchainArchiveSha256: toolchain.sha256,
	sourceArchiveSha256: manifest.source.archive.sha256,
	apiPatchSha256: manifest.source.apiPatch.sha256,
	patches: values.baseline ? [] : manifest.build.patches,
	target: manifest.build.target,
	optimize: manifest.build.optimize,
	versionString: manifest.build.versionString,
	bytes: bytes.length,
	sha256: expected,
}, null, 2) + "\n");
console.log(JSON.stringify({ output, bytes: bytes.length, sha256: expected, baseline: values.baseline }));
