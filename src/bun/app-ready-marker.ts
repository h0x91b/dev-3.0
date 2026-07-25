/**
 * Deterministic startup readiness signal for automated packaged-build proofs.
 *
 * CI needs to know a real installed app reached a usable state without scraping
 * logs or guessing a sleep duration. When `DEV3_READY_MARKER_FILE` is set the
 * main process writes a small JSON file once the main window exists and RPC is
 * wired; without the variable this is a no-op, so normal startup is untouched.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AppReadyMarker {
	ready: true;
	pid: number;
	version: string;
	platform: NodeJS.Platform;
	startedAt: string;
}

export function buildAppReadyMarker(version: string, now: Date = new Date()): AppReadyMarker {
	return {
		ready: true,
		pid: process.pid,
		version,
		platform: process.platform,
		startedAt: now.toISOString(),
	};
}

/**
 * Writes the marker atomically (temp file + rename in the same directory) so a
 * poller never observes a half-written file. Returns null when disabled or on
 * any failure — readiness reporting must never break app startup.
 */
export function writeAppReadyMarker(
	version: string,
	markerPath: string | undefined = process.env.DEV3_READY_MARKER_FILE,
): AppReadyMarker | null {
	if (!markerPath) return null;
	try {
		mkdirSync(dirname(markerPath), { recursive: true });
		const marker = buildAppReadyMarker(version);
		const tempPath = `${markerPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`);
		renameSync(tempPath, markerPath);
		return marker;
	} catch {
		return null;
	}
}
