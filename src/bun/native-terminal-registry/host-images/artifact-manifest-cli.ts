/**
 * Argument parsing + rendering for the artifact-manifest generator CLI.
 *
 * Kept separate from the `scripts/` entry shim so the exit-code contract
 * (0 ok / 1 typed rejection / 2 usage) is exercised in-process by the normal
 * vitest suite instead of by spawning a Bun binary that may not exist.
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
} from "./artifact-manifest";

export const ARTIFACT_MANIFEST_CLI_OK = 0;
export const ARTIFACT_MANIFEST_CLI_REJECTED = 1;
export const ARTIFACT_MANIFEST_CLI_USAGE = 2;

export interface ArtifactManifestCliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

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

/** Thrown for a malformed command line; mapped to exit code 2 by the caller. */
class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = { files: [] };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--file") {
			const value = argv[++index];
			if (value === undefined) throw new UsageError(`missing value for ${flag}`);
			parsed.files.push(value);
			continue;
		}
		const key = FLAG_KEYS[flag];
		if (!key) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
		const value = argv[++index];
		if (value === undefined) throw new UsageError(`missing value for ${flag}`);
		parsed[key] = value;
	}
	return parsed;
}

function required(parsed: ParsedArgs, key: keyof Omit<ParsedArgs, "files">, flag: string): string {
	const value = parsed[key];
	if (value === undefined) throw new UsageError(`missing required ${flag}`);
	return value;
}

/**
 * Run the generator with `argv` (already stripped of runtime + script path).
 * Returns the exit code plus the exact text the entry shim writes out; the only
 * side effect is the optional `--out` file.
 */
export function runArtifactManifestCli(argv: string[]): ArtifactManifestCliResult {
	try {
		const parsed = parseArgs(argv);
		const root = required(parsed, "root", "--root");
		const os = required(parsed, "os", "--os");
		const arch = required(parsed, "arch", "--arch");
		if (!MANIFEST_OS_VALUES.includes(os as ManifestOs)) throw new UsageError(`--os must be one of ${MANIFEST_OS_VALUES.join(", ")}`);
		if (!MANIFEST_ARCH_VALUES.includes(arch as ManifestArch)) throw new UsageError(`--arch must be one of ${MANIFEST_ARCH_VALUES.join(", ")}`);

		const protocolRaw = required(parsed, "protocolVersion", "--protocol-version");
		const protocolVersion = Number(protocolRaw);
		if (!Number.isInteger(protocolVersion)) throw new UsageError(`--protocol-version must be an integer, got ${JSON.stringify(protocolRaw)}`);

		const entrypoint = required(parsed, "entrypoint", "--entrypoint");
		const hostVersion = required(parsed, "hostVersion", "--host-version");
		const bunVersion = required(parsed, "bunVersion", "--bun-version");
		const files = parsed.files.length > 0 ? parsed.files : enumerateArtifactFiles(root);

		const manifest = generateManifest({
			artifactRoot: root,
			entrypoint,
			files,
			metadata: { hostVersion, protocolVersion, bunVersion, os: os as ManifestOs, arch: arch as ManifestArch },
		});
		const serialized = serializeManifest(manifest);
		if (!parsed.out) return { exitCode: ARTIFACT_MANIFEST_CLI_OK, stdout: serialized, stderr: "" };

		writeFileSync(parsed.out, serialized);
		return {
			exitCode: ARTIFACT_MANIFEST_CLI_OK,
			stdout: "",
			stderr: `[native-terminal-host-manifest] wrote ${manifest.files.length} file(s) to ${parsed.out}\n`,
		};
	} catch (err) {
		if (err instanceof UsageError) return { exitCode: ARTIFACT_MANIFEST_CLI_USAGE, stdout: "", stderr: `[usage] ${err.message}\n` };
		if (err instanceof ManifestError) return { exitCode: ARTIFACT_MANIFEST_CLI_REJECTED, stdout: "", stderr: `[${err.code}] ${err.message}\n` };
		throw err;
	}
}
