/**
 * Guards the two claims the compact-only mode rests on: nothing product-reachable
 * consumes the legacy per-cell artifact, and host/app version skew can only ever
 * degrade toward publishing nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCaptureMode } from "../capture-mode";
import { parseRecord, serializeRecord, type NativeSessionRecord } from "../record";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src
const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

/**
 * Everything allowed to read the per-cell snapshot. All of it is either inside the
 * registry, or a module that proves in its OWN isolation test that the app does
 * not import it. Add an entry here only with the compatibility argument to match:
 * a product consumer would mean compact-only removes something reachable.
 */
const SANCTIONED_SEMANTIC_CONSUMERS = [
	"bun/native-terminal-adapter/adapter.ts",
	"bun/native-terminal-adapter/view-reconstruction.ts",
	"bun/native-terminal-multipane/coordinator.ts",
	"bun/native-terminal-soak/metrics.ts",
	"bun/native-terminal-soak/soak-controller.ts",
];

describe("compact-only reachability", () => {
	it("has no product consumer of the legacy per-cell artifact", () => {
		const consumers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => !path.includes("__tests__"))
			.filter((path) => {
				const text = readFileSync(path, "utf8");
				return text.includes("readParserState") || text.includes("parserStateFile");
			})
			.map((path) => path.slice(sourceRoot.length + 1).replaceAll("\\", "/"))
			.sort();
		expect(consumers).toEqual(SANCTIONED_SEMANTIC_CONSUMERS);
	});

	it("keeps the retired flags and their env vars gone, with no shim left behind", () => {
		const offenders = sourceFiles(sourceRoot)
			.filter((path) => path !== fileURLToPath(import.meta.url))
			.filter((path) => {
				const text = readFileSync(path, "utf8");
				return (
					text.includes("DEV3_NATIVE_SESSION_LIVE_PARSER") ||
					text.includes("DEV3_NATIVE_SESSION_CAPTURE_PROJECTION") ||
					/\bliveParser\b/.test(text) ||
					/\bcaptureProjection\b/.test(text)
				);
			})
			.map((path) => path.slice(sourceRoot.length + 1));
		expect(offenders).toEqual([]);
	});
});

describe("host and app version skew", () => {
	const oldHostRecord = (): NativeSessionRecord => ({
		schemaVersion: 1,
		sessionId: "alpha",
		paneId: "alpha:0",
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 4242, executable: "/bin/bun", startSignature: "h" },
		shell: { pid: 4243, command: ["/bin/bash"], startSignature: "s" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-08-03T10:00:00.000Z",
		updatedAt: "2026-08-03T10:00:00.000Z",
	});

	it("never lets a new app read an OLD host as capture-enabled", () => {
		// An old host writes no capabilities block, whatever env it was handed.
		const parsed = parseRecord(serializeRecord(oldHostRecord()));
		expect(parsed).not.toHaveProperty("capabilities");
		expect(parsed?.capabilities?.capture ?? []).toEqual([]);
	});

	it("degrades an old host to `none` when it is handed the new mode env", () => {
		// The old host read DEV3_NATIVE_SESSION_LIVE_PARSER === "1" and nothing else,
		// so the new variable is simply not seen: no parser, no artifact, no claim.
		expect(parseCaptureMode("semantic")).toBe("semantic");
		expect(parseCaptureMode(undefined)).toBe("none");
		// And the reverse: a NEW host handed the retired boolean value reads `none`,
		// so a stale launcher cannot switch a parser on by accident either.
		expect(parseCaptureMode("1")).toBe("none");
	});
});
