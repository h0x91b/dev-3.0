#!/usr/bin/env bun
/**
 * Standalone CLI wrapper around generateManifest() — invoked directly with Bun,
 * never wired into package.json:
 *
 *   bun scripts/native-terminal-host-manifest/generate.ts \
 *     --root dist/native \
 *     --entrypoint dev3-terminal-host.js \
 *     --host-version 1.2.3 --protocol-version 2 --bun-version 1.3.14 \
 *     --os win32 --arch x64 \
 *     [--file dev3-terminal-host.js --file conpty/conpty.dll ...] \
 *     [--out dist/native/manifest.json]
 *
 * When no --file is given, every regular file under --root is enumerated. The
 * emitted JSON is byte-identical for identical inputs. On any rejection a compact
 * `[code] message` line is written to stderr and the process exits non-zero.
 */

import { writeFileSync } from "node:fs";
import {
	enumerateArtifactFiles,
	generateManifest,
	ManifestError,
	MANIFEST_ARCH_VALUES,
	MANIFEST_OS_VALUES,
	serializeManifest,
	type ManifestArch,
	type ManifestOs,
} from "./manifest";

const USAGE_EXIT = 2;
const REJECTION_EXIT = 1;

interface ParsedArgs {
	root?: string;
	entrypoint?: string;
	hostVersion?: string;
	protocolVersion?: string;
	bunVersion?: string;
	os?: string;
	arch?: string;
	out?: string;
	files: string[];
}

const FLAG_KEYS: Record<string, keyof Omit<ParsedArgs, "files">> = {
	"--root": "root",
	"--entrypoint": "entrypoint",
	"--host-version": "hostVersion",
	"--protocol-version": "protocolVersion",
	"--bun-version": "bunVersion",
	"--os": "os",
	"--arch": "arch",
	"--out": "out",
};

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = { files: [] };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--file") {
			const value = argv[++index];
			if (value === undefined) usageError(`missing value for ${flag}`);
			parsed.files.push(value);
			continue;
		}
		const key = FLAG_KEYS[flag];
		if (!key) usageError(`unknown argument ${JSON.stringify(flag)}`);
		const value = argv[++index];
		if (value === undefined) usageError(`missing value for ${flag}`);
		parsed[key] = value;
	}
	return parsed;
}

function usageError(message: string): never {
	process.stderr.write(`[usage] ${message}\n`);
	process.exit(USAGE_EXIT);
}

function required(parsed: ParsedArgs, key: keyof Omit<ParsedArgs, "files">, flag: string): string {
	const value = parsed[key];
	if (value === undefined) usageError(`missing required ${flag}`);
	return value;
}

function main(argv: string[]): void {
	const parsed = parseArgs(argv);
	const root = required(parsed, "root", "--root");
	const os = required(parsed, "os", "--os");
	const arch = required(parsed, "arch", "--arch");
	if (!MANIFEST_OS_VALUES.includes(os as ManifestOs)) usageError(`--os must be one of ${MANIFEST_OS_VALUES.join(", ")}`);
	if (!MANIFEST_ARCH_VALUES.includes(arch as ManifestArch)) usageError(`--arch must be one of ${MANIFEST_ARCH_VALUES.join(", ")}`);

	const protocolRaw = required(parsed, "protocolVersion", "--protocol-version");
	const protocolVersion = Number(protocolRaw);
	if (!Number.isInteger(protocolVersion)) usageError(`--protocol-version must be an integer, got ${JSON.stringify(protocolRaw)}`);

	const files = parsed.files.length > 0 ? parsed.files : enumerateArtifactFiles(root);

	const manifest = generateManifest({
		artifactRoot: root,
		entrypoint: required(parsed, "entrypoint", "--entrypoint"),
		files,
		metadata: {
			hostVersion: required(parsed, "hostVersion", "--host-version"),
			protocolVersion,
			bunVersion: required(parsed, "bunVersion", "--bun-version"),
			os: os as ManifestOs,
			arch: arch as ManifestArch,
		},
	});

	const serialized = serializeManifest(manifest);
	if (parsed.out) {
		writeFileSync(parsed.out, serialized);
		process.stderr.write(`[native-terminal-host-manifest] wrote ${manifest.files.length} file(s) to ${parsed.out}\n`);
	} else {
		process.stdout.write(serialized);
	}
}

try {
	main(process.argv.slice(2));
} catch (err) {
	if (err instanceof ManifestError) {
		process.stderr.write(`[${err.code}] ${err.message}\n`);
		process.exit(REJECTION_EXIT);
	}
	throw err;
}
