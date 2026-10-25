import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const packageFiles = [
	"LICENSE",
	"README.md",
	"dist/__vite-browser-external-2447137e.js",
	"dist/ghostty-vt.wasm",
	"dist/ghostty-web.js",
	"dist/ghostty-web.umd.cjs",
	"dist/index.d.ts",
	"ghostty-vt.wasm",
	"package.json",
] as const;

const changedPaths = [
	"dist/ghostty-vt.wasm",
	"dist/ghostty-web.js",
	"dist/ghostty-web.umd.cjs",
	"ghostty-vt.wasm",
	"package.json",
];
const wasmFiles = ["ghostty-vt.wasm", "dist/ghostty-vt.wasm"];
const bundles = ["dist/ghostty-web.js", "dist/ghostty-web.umd.cjs"];
const maxTarBytes = 16 * 1024 * 1024;
type Files = Map<string, Buffer>;

export interface PackageManifest {
	name: "ghostty-web";
	upstreamVersion: "0.4.0";
	version: string;
	upstreamIntegrity: string;
	upstreamWasmSha256: string;
	wasmSha256: string;
	disposalPatch: { path: string; sha256: string };
	archivePath: string;
	archiveSha256?: string;
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function repositoryPath(path: string): string {
	check(!isAbsolute(path) && !path.split(/[\\/]/).includes(".."), `Expected repository-relative path: ${path}`);
	return resolve(repositoryRoot, path);
}

export function loadPackageManifest(path: string): PackageManifest {
	const manifest = JSON.parse(readFileSync(path, "utf8")).package as PackageManifest;
	check(manifest && typeof manifest === "object", "Manifest must contain a package object");
	check(manifest.name === "ghostty-web" && manifest.upstreamVersion === "0.4.0", "Unsupported upstream package");
	check(/^0\.4\.0-dev3\.[1-9]\d*$/.test(manifest.version), "Expected an explicit 0.4.0-dev3.N package version");
	check(/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.upstreamIntegrity), "Expected upstream SHA-512 integrity");
	for (const key of ["upstreamWasmSha256", "wasmSha256"] as const) {
		check(/^[a-f0-9]{64}$/.test(manifest[key]), `Invalid ${key}`);
	}
	check(manifest.disposalPatch && /^[a-f0-9]{64}$/.test(manifest.disposalPatch.sha256), "Invalid disposal patch hash");
	check(typeof manifest.disposalPatch.path === "string", "Missing disposal patch path");
	check(typeof manifest.archivePath === "string" && manifest.archivePath.endsWith(".tgz"), "Missing package archive path");
	if (manifest.archiveSha256 !== undefined) check(/^[a-f0-9]{64}$/.test(manifest.archiveSha256), "Invalid archive hash");
	repositoryPath(manifest.disposalPatch.path);
	repositoryPath(manifest.archivePath);
	return manifest;
}

function tarString(header: Buffer, offset: number, length: number): string {
	const field = header.subarray(offset, offset + length);
	const end = field.indexOf(0);
	return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarNumber(header: Buffer, offset: number, length: number): number {
	const value = tarString(header, offset, length).trim();
	check(/^[0-7]+$/.test(value), "Invalid tar number");
	const number = Number.parseInt(value, 8);
	check(Number.isSafeInteger(number), "Tar number exceeds safe range");
	return number;
}

function headerChecksum(header: Buffer): number {
	return header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
}

function assertFileList(files: Files): void {
	check(JSON.stringify([...files.keys()].sort()) === JSON.stringify(packageFiles), "Unexpected package file list");
}

export function readPackageArchive(archive: Buffer): Files {
	check(archive.length <= maxTarBytes, "Package archive is too large");
	const tar = gunzipSync(archive, { maxOutputLength: maxTarBytes });
	check(tar.length % 512 === 0, "Unaligned tar archive");
	const files: Files = new Map();
	let offset = 0;
	let ended = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			check(tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0), "Invalid tar trailer");
			ended = true;
			break;
		}
		check(tarNumber(header, 148, 8) === headerChecksum(header), "Invalid tar header checksum");
		check(tarString(header, 257, 6) === "ustar", "Expected a ustar archive");
		const prefix = tarString(header, 345, 155);
		const name = (prefix ? `${prefix}/` : "") + tarString(header, 0, 100);
		check(name.startsWith("package/") && !name.split("/").includes("..") && !name.includes("\\"), "Invalid tar path");
		const size = tarNumber(header, 124, 12);
		const type = header[156];
		check(type === 0 || type === 48 || type === 53, `Unsupported tar entry: ${name}`);
		check(offset + 512 + size <= tar.length, "Truncated tar entry");
		if (type === 53) {
			check(size === 0 && (name === "package/" || name === "package/dist/"), "Unexpected tar directory");
		} else {
			const path = name.slice("package/".length);
			check(!files.has(path), `Duplicate tar entry: ${path}`);
			files.set(path, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	check(ended, "Missing tar trailer");
	assertFileList(files);
	return files;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	check(encoded.length === length - 1, "Tar field overflow");
	header.write(encoded, offset, "ascii");
}

export function writePackageArchive(files: Files): Buffer {
	assertFileList(files);
	const chunks: Buffer[] = [];
	for (const path of packageFiles) {
		const bytes = files.get(path)!;
		const header = Buffer.alloc(512);
		header.write(`package/${path}`, 0, "ascii");
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, bytes.length);
		writeOctal(header, 136, 12, 0);
		header[156] = 48;
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		writeOctal(header, 329, 8, 0);
		writeOctal(header, 337, 8, 0);
		header.write(headerChecksum(header).toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
		chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
	}
	chunks.push(Buffer.alloc(1024));
	const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
	// Normalize gzip's timestamp and OS fields across build hosts.
	archive.fill(0, 4, 8);
	archive[9] = 255;
	return archive;
}

function applyDisposalPatch(source: Buffer, patch: Buffer): Buffer {
	const patchLines = patch.toString("utf8").trimEnd().split("\n");
	check(patchLines[0] === "diff --git a/dist/ghostty-web.js b/dist/ghostty-web.js", "Unexpected disposal patch target");
	check(patchLines.filter((line) => line.startsWith("diff --git ")).length === 1, "Disposal patch must change only ESM");
	check(patchLines[2] === "--- a/dist/ghostty-web.js" && patchLines[3] === "+++ b/dist/ghostty-web.js", "Invalid disposal patch paths");
	const original = source.toString("utf8").split("\n");
	const output: string[] = [];
	let cursor = 0;
	let hunks = 0;
	for (let index = 4; index < patchLines.length;) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[index++]);
		check(header, "Invalid disposal patch hunk");
		const start = Number(header[1]) - 1;
		check(start >= cursor && start <= original.length, "Overlapping disposal patch hunk");
		output.push(...original.slice(cursor, start));
		cursor = start;
		check(output.length === Number(header[3]) - 1, "Disposal patch output position mismatch");
		let removed = 0;
		let added = 0;
		while (index < patchLines.length && !patchLines[index].startsWith("@@ ")) {
			const line = patchLines[index++];
			check([" ", "+", "-"].includes(line[0]), "Unsupported disposal patch line");
			if (line[0] !== "+") {
				check(original[cursor++] === line.slice(1), "Disposal patch context mismatch");
				removed++;
			}
			if (line[0] !== "-") {
				output.push(line.slice(1));
				added++;
			}
		}
		check(removed === Number(header[2] ?? 1) && added === Number(header[4] ?? 1), "Disposal patch hunk size mismatch");
		hunks++;
	}
	check(hunks > 0, "Empty disposal patch");
	output.push(...original.slice(cursor));
	return Buffer.from(output.join("\n"));
}

function embeddedWasm(bundle: Buffer): { text: string; payload: string; bytes: Buffer } {
	const text = bundle.toString("utf8");
	check(Buffer.from(text).equals(bundle), "Invalid UTF-8 in JavaScript bundle");
	const matches = [...text.matchAll(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/g)];
	check(matches.length === 1, "Expected exactly one embedded WASM payload");
	const payload = matches[0][1];
	const bytes = Buffer.from(payload, "base64");
	check(bytes.toString("base64") === payload, "Invalid WASM base64");
	return { text, payload, bytes };
}

function validateWasmCopies(files: Files, expectedHash: string): Buffer {
	const copies = [...wasmFiles.map((path) => files.get(path)!), ...bundles.map((path) => embeddedWasm(files.get(path)!).bytes)];
	for (const copy of copies) check(sha256(copy) === expectedHash && copy.equals(copies[0]), "WASM copies disagree with manifest");
	check(WebAssembly.validate(new Uint8Array(copies[0])), "Invalid WASM module");
	return copies[0];
}

function assertWasmSurface(original: Buffer, repaired: Buffer): void {
	const before = new WebAssembly.Module(new Uint8Array(original));
	const after = new WebAssembly.Module(new Uint8Array(repaired));
	for (const descriptors of [WebAssembly.Module.imports, WebAssembly.Module.exports]) {
		check(JSON.stringify(descriptors(before)) === JSON.stringify(descriptors(after)), "WASM import/export surface changed");
	}
}

export function createPackageFiles(manifest: PackageManifest, upstream: Buffer, wasm: Buffer, patch: Buffer): Files {
	const integrity = `sha512-${createHash("sha512").update(upstream).digest("base64")}`;
	check(integrity === manifest.upstreamIntegrity, "Upstream archive integrity mismatch");
	check(sha256(wasm) === manifest.wasmSha256, "Selected WASM hash mismatch");
	check(sha256(patch) === manifest.disposalPatch.sha256, "Disposal patch hash mismatch");
	const original = readPackageArchive(upstream);
	const originalWasm = validateWasmCopies(original, manifest.upstreamWasmSha256);
	assertWasmSurface(originalWasm, wasm);
	const files: Files = new Map(original);
	files.set("dist/ghostty-web.js", applyDisposalPatch(original.get("dist/ghostty-web.js")!, patch));
	for (const path of bundles) {
		const embedded = embeddedWasm(files.get(path)!);
		files.set(path, Buffer.from(embedded.text.replace(`data:application/wasm;base64,${embedded.payload}`, `data:application/wasm;base64,${wasm.toString("base64")}`)));
	}
	for (const path of wasmFiles) files.set(path, Buffer.from(wasm));
	const json = original.get("package.json")!.toString("utf8");
	const metadata = JSON.parse(json);
	check(metadata.name === manifest.name && metadata.version === manifest.upstreamVersion, "Upstream package identity mismatch");
	const versions = [...json.matchAll(/^(\s*"version":\s*)"([^"]+)"/gm)];
	check(versions.length === 1 && versions[0][2] === manifest.upstreamVersion, "Unexpected package version field");
	files.set("package.json", Buffer.from(json.replace(versions[0][0], `${versions[0][1]}${JSON.stringify(manifest.version)}`)));
	const changed = packageFiles.filter((path) => !original.get(path)!.equals(files.get(path)!));
	check(JSON.stringify(changed) === JSON.stringify(changedPaths), "Unexpected changed package paths");
	validateWasmCopies(files, manifest.wasmSha256);
	return files;
}

export function verifyPackageArchive(manifest: PackageManifest, upstream: Buffer, patch: Buffer, archive: Buffer) {
	const files = readPackageArchive(archive);
	const expected = createPackageFiles(manifest, upstream, files.get("ghostty-vt.wasm")!, patch);
	for (const path of packageFiles) check(files.get(path)!.equals(expected.get(path)!), `Unexpected packaged bytes: ${path}`);
	check(writePackageArchive(expected).equals(archive), "Package tar/gzip encoding is not deterministic");
	const archiveSha256 = sha256(archive);
	if (manifest.archiveSha256) check(archiveSha256 === manifest.archiveSha256, "Package archive hash mismatch");
	return {
		name: manifest.name,
		version: manifest.version,
		archiveSha256,
		archiveBytes: archive.length,
		wasmSha256: manifest.wasmSha256,
		changedPaths,
		files: packageFiles.map((path) => ({ path, bytes: files.get(path)!.length, sha256: sha256(files.get(path)!) })),
	};
}

export function verifyInstalledFiles(directory: string, archive: Buffer): void {
	const files = readPackageArchive(archive);
	const installed: string[] = [];
	function collect(relative: string): void {
		for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
			if (!relative && /^\.bun-tag-[a-f0-9]+$/.test(entry.name)) continue;
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) collect(path);
			else installed.push(path);
		}
	}
	collect("");
	check(JSON.stringify(installed.sort()) === JSON.stringify(packageFiles), "Unexpected installed package file list");
	for (const path of packageFiles) check(readFileSync(join(directory, path)).equals(files.get(path)!), `Installed package differs: ${path}`);
}

export function parseOptions(args: string[], allowed: string[]): Record<string, string> {
	const options: Record<string, string> = {};
	for (let index = 0; index < args.length; index++) {
		const key = args[index];
		check(allowed.includes(key) && options[key] === undefined, `Unknown or duplicate option: ${key}`);
		if (key === "--help") options[key] = "true";
		else {
			const value = args[++index];
			check(value && !value.startsWith("--"), `Missing value for ${key}`);
			options[key] = value;
		}
	}
	return options;
}
