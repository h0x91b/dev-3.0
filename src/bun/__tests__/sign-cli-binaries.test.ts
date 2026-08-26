import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/sign-cli-binaries.sh",
);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeExecutable(path: string, content: string) {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

describe("sign-cli-binaries.sh", () => {
	it("uses Developer ID signing for the CLI binary during release builds", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-sign-cli-"));
		tempDirs.push(tempDir);

		const distDir = join(tempDir, "dist");
		const binDir = join(tempDir, "bin");
		const logPath = join(tempDir, "codesign.log");

		mkdirSync(distDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });

		writeFileSync(join(distDir, "dev3"), "fake");

		writeExecutable(join(binDir, "uname"), "#!/bin/bash\necho Darwin\n");
		writeExecutable(
			join(binDir, "codesign"),
			`#!/bin/bash
echo "$@" >> "${logPath}"
exit 0
`,
		);

		const result = spawnSync("bash", [SCRIPT_PATH], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example Corp (TEAMID)",
			},
		});

		expect(result.status).toBe(0);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("--remove-signature dist/dev3");
		expect(log).toContain(
			'--force --verbose --timestamp --sign Developer ID Application: Example Corp (TEAMID) --options runtime --entitlements scripts/cli-entitlements.plist dist/dev3',
		);
		// Ad-hoc fallback must NOT be used when a Developer ID is present.
		expect(log).not.toContain("--sign - dist/dev3");
	});

	// Hardened runtime without these two makes every `bun:ffi` dlopen in the CLI
	// binary SIGTRAP — it killed `dev3 remote` on the CoW clone of task creation.
	// See decisions/2026/08/26/sign-cli-binary-with-jit-entitlements.md.
	it("grants the CLI binary the JIT entitlements bun:ffi needs", () => {
		const plist = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/cli-entitlements.plist"),
			"utf8",
		);
		expect(plist).toContain("com.apple.security.cs.allow-jit");
		expect(plist).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
	});

	it("hardens and entitles the ad-hoc local signature too, matching release", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-sign-cli-adhoc-"));
		tempDirs.push(tempDir);

		const distDir = join(tempDir, "dist");
		const binDir = join(tempDir, "bin");
		const logPath = join(tempDir, "codesign.log");

		mkdirSync(distDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(distDir, "dev3"), "fake");

		writeExecutable(join(binDir, "uname"), "#!/bin/bash\necho Darwin\n");
		writeExecutable(
			join(binDir, "codesign"),
			`#!/bin/bash
echo "$@" >> "${logPath}"
exit 0
`,
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		};
		delete env.ELECTROBUN_DEVELOPER_ID;

		const result = spawnSync("bash", [SCRIPT_PATH], { cwd: tempDir, encoding: "utf8", env });

		expect(result.status).toBe(0);
		expect(readFileSync(logPath, "utf8")).toContain(
			"--force --sign - --options runtime --entitlements scripts/cli-entitlements.plist dist/dev3",
		);
	});
});
