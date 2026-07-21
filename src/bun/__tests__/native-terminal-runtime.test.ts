import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sameNativeTerminalPath } from "../../shared/native-terminal-runtime";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createTemporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-terminal-path-"));
	temporaryRoots.push(root);
	return root;
}

describe("native terminal runtime path identity", () => {
	it("accepts different filesystem aliases for the same runtime", () => {
		const root = createTemporaryRoot();
		const runtimePath = join(root, "dev3-terminal-host.exe");
		const aliasPath = join(root, "DEV3TE~1.EXE");
		writeFileSync(runtimePath, "runtime");
		linkSync(runtimePath, aliasPath);

		expect(sameNativeTerminalPath(runtimePath, aliasPath)).toBe(true);
	});

	it("rejects different files with different identities", () => {
		const root = createTemporaryRoot();
		const firstPath = join(root, "first.exe");
		const secondPath = join(root, "second.exe");
		writeFileSync(firstPath, "first");
		writeFileSync(secondPath, "second");

		expect(sameNativeTerminalPath(firstPath, secondPath)).toBe(false);
	});
});
