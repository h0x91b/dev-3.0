/**
 * What the compatibility claim actually rests on.
 *
 * The claim is narrow on purpose: production published NEITHER capture artifact
 * before this change, so compact-only removes nothing an older build could read.
 * That is a statement about disk state, not reachability — the semantic surface IS
 * reachable from the seam and stays a supported fallback. The walk below measures
 * which entrypoints can reach the per-cell reader, so the claim is stated against a
 * real import graph rather than a grep over an allowlist.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCaptureMode } from "../capture-mode";
import { parseRecord, serializeRecord, type NativeSessionRecord } from "../record";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src

/** The real entrypoints a user's dev3 runs. */
const ENTRYPOINTS = ["bun/index.ts", "cli/main.ts", "bun/native-terminal-host/main.ts"];

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveImport(fromFile: string, spec: string): string | null {
	const base = resolve(dirname(fromFile), spec);
	for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/** Every file reachable by relative import from the given entrypoints. */
function reachableFiles(entrypoints: string[]): Set<string> {
	const seen = new Set<string>();
	const queue = entrypoints.map((entry) => resolve(sourceRoot, entry)).filter(isFile);
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
			const target = resolveImport(file, match[1]!);
			if (target && !seen.has(target)) queue.push(target);
		}
	}
	return seen;
}

function relative(file: string): string {
	return file.slice(sourceRoot.length + 1).replaceAll("\\", "/");
}

describe("per-cell artifact reachability", () => {
	const reachable = reachableFiles(ENTRYPOINTS);

	it("reaches the app and CLI entrypoints at all, so the walk proves something", () => {
		// A resolver that silently found nothing would make every claim below vacuous.
		expect(reachable.size).toBeGreaterThan(50);
		expect([...reachable].map(relative)).toContain("bun/task-terminal-backend.ts");
	});

	it("reaches the per-cell reader ONLY through the capture seam's semantic fallback", () => {
		const readers = [...reachable]
			.filter((file) => /\breadParserState\b|\bparserStateFile\b/.test(readFileSync(file, "utf8")))
			.map(relative)
			.sort();
		// The honest result: the seam's own fallback is the one product consumer, which
		// is why semantic stays supported rather than unreachable legacy, and why the
		// compatibility claim is about what production PUBLISHED, not about reach.
		// The real graph names two files the earlier allowlist-plus-grep missed: the
		// adapter's renderer, reached through the coordinator, and the record module,
		// which knows the path in order to CLEAN it up.
		expect(readers).toEqual([
			"bun/native-terminal-adapter/view-reconstruction.ts",
			"bun/native-terminal-multipane/coordinator.ts",
			"bun/native-terminal-registry/parser-state.ts",
			"bun/native-terminal-registry/paths.ts",
			"bun/native-terminal-registry/record.ts",
		]);
	});

	it("keeps the retired flags and their env spellings gone, in every form", () => {
		const RETIRED = [
			"DEV3_NATIVE_SESSION_LIVE_PARSER",
			"DEV3_NATIVE_SESSION_CAPTURE_PROJECTION",
			"--live-parser",
		];
		const offenders: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.(?:ts|tsx|md)$/.test(entry.name)) continue;
				if (path === fileURLToPath(import.meta.url)) continue;
				const text = readFileSync(path, "utf8");
				const camel = /\bliveParser\b|\bcaptureProjection\b/.test(text);
				if (camel || RETIRED.some((spelling) => text.includes(spelling))) offenders.push(relative(path));
			}
		};
		walk(sourceRoot);
		expect(offenders.sort()).toEqual([]);
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
		const parsed = parseRecord(serializeRecord(oldHostRecord()));
		expect(parsed).not.toHaveProperty("capabilities");
		expect(parsed?.capabilities?.capture ?? []).toEqual([]);
	});

	it("degrades an unrecognised ambient mode to none in either direction", () => {
		expect(parseCaptureMode("semantic")).toBe("semantic");
		expect(parseCaptureMode(undefined)).toBe("none");
		// The retired boolean value a stale launcher might still pass.
		expect(parseCaptureMode("1")).toBe("none");
	});
});
