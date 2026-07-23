#!/usr/bin/env bun
/**
 * Version-skew + immutable-host-image lifecycle proof (seq 1248), on the REAL
 * Bun runtime (vitest stubs Bun, so a live Bun.Terminal cannot run there —
 * mirrors test:native-registry-e2e). Run: `bun run test:native-host-images-e2e`.
 *
 * Proves, against two IMMUTABLE staged host images (v1, v2) each owning a real
 * shell over the real hello/version boundary:
 *   • an incompatible NEW client (v2) attaching to the OLD (v1) session gets one
 *     actionable version-mismatch, while the old host PID, shell PID, pane id,
 *     endpoint, and live shell STATE all remain untouched;
 *   • a compatible (v1) client still reattaches to that unchanged old session and
 *     reads back the shell state set before the rejected attempt;
 *   • a NEW session boots on the NEWLY staged v2 image while the old session keeps
 *     running on the v1 image — distinct host/shell PIDs, distinct entrypoint
 *     files, no in-place executable replacement (v1 image byte-identical), no live
 *     PTY takeover (old PIDs unchanged);
 *   • rollback selects a compatible staged image EXPLICITLY (never newest, never a
 *     tmux fallback) and boots the chosen old image while a newer image exists;
 *   • missing and partially-staged images produce honest diagnostics and destroy
 *     no live session;
 *   • the observed verdicts match the compact version/session matrix, and tmux is
 *     never invoked (PATH-shim sentinel stays absent).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fingerprintImage, HostImageAlreadyStagedError, imageDir, manifestPath, readStagedImage, stageHostImage } from "../staging";
import { sameNativeTerminalPath } from "../../../../shared/native-terminal-runtime";
import { selectImageByTag, selectImageForProtocol } from "../rollback";
import { launchStagedHost, stageStandardImages, VersionedLabClient, type LaunchedHost } from "../lab";
import { buildSkewMatrix, renderSkewMatrix } from "../version-skew";
import { readHostSessionRecord } from "../session-record";

let failures = 0;
function check(condition: boolean, msg: string): void {
	if (condition) console.log(`  ok   - ${msg}`);
	else {
		failures++;
		console.error(`  FAIL - ${msg}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const STAGED_AT = new Date().toISOString();

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function setStateCommand(nonce: string): string {
	return isWindows ? `$env:SESSION_STATE='${nonce}'` : `export SESSION_STATE=${nonce}`;
}
function echoStateCommand(label: string): string {
	return isWindows ? `Write-Output "${label}:$env:SESSION_STATE"` : `echo "${label}:$SESSION_STATE"`;
}
function echoMarkerCommand(label: string): string {
	return isWindows ? `Write-Output "${label}:$env:DEV3_HIMG_STATE"` : `echo "${label}:$DEV3_HIMG_STATE"`;
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-host-images-e2e-"));
	const stagingRoot = join(root, "staging");
	const sessionsRoot = join(root, "sessions");
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(sessionsRoot, { recursive: true });
	mkdirSync(shimDir, { recursive: true });
	const shim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(shim, isWindows ? `@echo off\r\necho called>>"${sentinel}"\r\nexit /b 0\r\n` : `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`);
	if (!isWindows) chmodSync(shim, 0o755);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const nonce = `n${Date.now()}`;
	const oldMarker = `oldmark${Date.now()}`;
	const newMarker = `newmark${Date.now()}`;
	const launched: LaunchedHost[] = [];

	try {
		// ── 1. stage two IMMUTABLE images; the second never rewrites the first ──
		stageStandardImages(stagingRoot, STAGED_AT);
		const v1Fingerprint = fingerprintImage(stagingRoot, "host-v1");
		const v2Fingerprint = fingerprintImage(stagingRoot, "host-v2");
		check(v1Fingerprint !== null && v2Fingerprint !== null && v1Fingerprint !== v2Fingerprint, "two distinct immutable images staged (v1, v2)");
		let reStageThrew = false;
		try {
			stageHostImage(stagingRoot, { tag: "host-v1", protocolVersion: 9, stagedAt: STAGED_AT });
		} catch (err) {
			reStageThrew = err instanceof HostImageAlreadyStagedError;
		}
		check(reStageThrew, "re-staging an existing image is refused (no in-place executable replacement)");

		// ── 2. launch the OLD session from the v1 image ──
		const oldStateDir = join(sessionsRoot, "old");
		const old = await launchStagedHost({ root: stagingRoot, tag: "host-v1", protocolVersion: 1, sessionId: "old", stateDir: oldStateDir, marker: oldMarker });
		launched.push(old);
		const oldHostPid = old.record.hostPid;
		const oldShellPid = old.record.shellPid;
		const oldPaneId = old.record.paneId;
		const oldPort = old.record.endpoint.port;
		const v1Image = readStagedImage(stagingRoot, "host-v1");
		check(old.record.protocolVersion === 1, "old session host speaks protocol v1");
		check(v1Image.status === "ok" && sameNativeTerminalPath(old.record.entrypoint, v1Image.entrypointPath), "old host runs the v1 image's own entrypoint file");
		check(isAlive(oldHostPid) && isAlive(oldShellPid), "old host + shell are alive after launch");

		// ── 3. compatible v1 client sets live shell state, then disconnects ──
		const v1a = new VersionedLabClient(1);
		const welcome1 = await v1a.attach(old.record, old.token);
		check(welcome1.status === "welcomed" && welcome1.negotiatedProtocolVersion === 1, "compatible v1 client is welcomed by the v1 host");
		v1a.input(`${setStateCommand(nonce)}${lineEnd}`);
		v1a.input(`${echoStateCommand("STATE1")}${lineEnd}`);
		check(await v1a.waitForText(`STATE1:${nonce}`), "v1 client drives the live shell and reads its own state back");
		v1a.input(`${echoMarkerCommand("MARK")}${lineEnd}`);
		check(await v1a.waitForText(`MARK:${oldMarker}`), "shell carries the boot state marker recorded for the session");
		v1a.close();
		await delay(150);
		check(isAlive(oldHostPid) && isAlive(oldShellPid), "old host + shell survive the client disconnect");

		// ── 4. incompatible NEW (v2) client attaches to the OLD (v1) session ──
		const v2Bad = new VersionedLabClient(2);
		const rejected = await v2Bad.attach(old.record, old.token);
		v2Bad.close();
		check(rejected.status === "rejected", "incompatible v2 client attaching to the v1 session is rejected");
		if (rejected.status === "rejected") {
			check(rejected.error.code === "version-mismatch", "the rejection is a version-mismatch");
			check(typeof rejected.error.message === "string" && rejected.error.message.includes("v1"), "the rejection is actionable (names the host's protocol version)");
		}
		// The live session is completely untouched by the rejected handshake.
		const oldAfterReject = readHostSessionRecord(oldStateDir);
		check(isAlive(oldHostPid) && isAlive(oldShellPid), "old host PID + shell PID remain alive after the rejected attempt");
		check(!!oldAfterReject && oldAfterReject.hostPid === oldHostPid && oldAfterReject.shellPid === oldShellPid, "old host/shell PIDs unchanged in the record");
		check(!!oldAfterReject && oldAfterReject.paneId === oldPaneId && oldAfterReject.endpoint.port === oldPort, "old pane id + endpoint unchanged after the rejected attempt");

		// ── 5. compatible v1 client reattaches; shell STATE survived the rejection ──
		const v1b = new VersionedLabClient(1);
		const welcome2 = await v1b.attach(old.record, old.token);
		check(welcome2.status === "welcomed", "compatible v1 client can still reattach after the rejected attempt");
		v1b.input(`${echoStateCommand("STATE2")}${lineEnd}`);
		check(await v1b.waitForText(`STATE2:${nonce}`), "reattached v1 client reads back the shell state set before the rejection (state preserved)");
		const st = await v1b.status();
		check(st.hostPid === oldHostPid && st.shellPid === oldShellPid && st.paneId === oldPaneId, "reattached status reports the UNCHANGED host/shell/pane");
		v1b.close();

		// ── 6. NEW session on the NEW v2 image while OLD continues on the v1 image ──
		const newStateDir = join(sessionsRoot, "new");
		const fresh = await launchStagedHost({ root: stagingRoot, tag: "host-v2", protocolVersion: 2, sessionId: "new", stateDir: newStateDir, marker: newMarker });
		launched.push(fresh);
		const v2Image = readStagedImage(stagingRoot, "host-v2");
		check(fresh.record.protocolVersion === 2, "new session host speaks protocol v2");
		check(v2Image.status === "ok" && sameNativeTerminalPath(fresh.record.entrypoint, v2Image.entrypointPath), "new host runs the v2 image's own entrypoint file");
		check(fresh.record.hostPid !== oldHostPid && fresh.record.shellPid !== oldShellPid, "new session has distinct host + shell PIDs");
		check(fresh.record.entrypoint !== old.record.entrypoint, "the two hosts ran different, per-image entrypoint files");
		// No in-place replacement + no live takeover.
		check(fingerprintImage(stagingRoot, "host-v1") === v1Fingerprint, "v1 image is byte-identical after v2 session launched (no in-place executable replacement)");
		check(isAlive(oldHostPid) && isAlive(oldShellPid), "old host + shell keep running on the v1 image (no live PTY takeover)");

		// Symmetric skew proof against the NEW v2 host.
		const v2Good = new VersionedLabClient(2);
		const welcome3 = await v2Good.attach(fresh.record, fresh.token);
		check(welcome3.status === "welcomed" && welcome3.negotiatedProtocolVersion === 2, "compatible v2 client is welcomed by the v2 host");
		v2Good.close();
		const v1BadToNew = new VersionedLabClient(1);
		const rejectedNew = await v1BadToNew.attach(fresh.record, fresh.token);
		v1BadToNew.close();
		check(rejectedNew.status === "rejected" && rejectedNew.error.code === "version-mismatch", "incompatible v1 client attaching to the v2 session is rejected too");
		check(isAlive(fresh.record.hostPid) && isAlive(fresh.record.shellPid), "new v2 session survives the rejected v1 handshake");

		// ── 7. rollback selects a compatible staged image EXPLICITLY (never guesses) ──
		const before = { v1: fingerprintImage(stagingRoot, "host-v1"), v2: fingerprintImage(stagingRoot, "host-v2") };
		const pickV1 = selectImageForProtocol(stagingRoot, 1);
		check(pickV1.status === "selected" && pickV1.tag === "host-v1", "rollback selects the v1 image explicitly, not the newest v2");
		const pickNone = selectImageForProtocol(stagingRoot, 3);
		check(pickNone.status === "no-compatible-image", "an unavailable protocol version yields no-compatible-image, never a fallback");
		if (pickNone.status === "no-compatible-image") check(JSON.stringify(pickNone.availableProtocolVersions) === "[1,2]", "no-compatible-image reports what IS available for a diagnostic");
		const after = { v1: fingerprintImage(stagingRoot, "host-v1"), v2: fingerprintImage(stagingRoot, "host-v2") };
		check(JSON.stringify(after) === JSON.stringify(before), "rollback selection mutated no image metadata (read-only)");
		// Boot a rollback session from the explicitly selected old image, alongside the newer one.
		const rbSel = selectImageByTag(stagingRoot, "host-v1");
		check(rbSel.status === "selected", "rollback resolves the chosen image by tag");
		const rollbackStateDir = join(sessionsRoot, "rollback");
		const rollback = await launchStagedHost({ root: stagingRoot, tag: "host-v1", protocolVersion: 1, sessionId: "rollback", stateDir: rollbackStateDir, marker: "rb" });
		launched.push(rollback);
		check(rollback.record.protocolVersion === 1 && isAlive(rollback.record.hostPid), "rollback session boots the selected v1 image while v2 stays staged");

		// ── 8. missing + partial staging: honest diagnostics, no session destruction ──
		check(readStagedImage(stagingRoot, "ghost").status === "missing", "a missing image reads as missing");
		const partialTag = "host-partial";
		mkdirSync(imageDir(stagingRoot, partialTag), { recursive: true });
		writeFileSync(
			manifestPath(stagingRoot, partialTag),
			JSON.stringify({ imageSchemaVersion: 1, tag: partialTag, protocolVersion: 5, hostArtifactVersion: "5", entrypoint: "entrypoint.mjs", runtimeFloor: "1.3.14", stagedAt: STAGED_AT }),
		);
		const partial = readStagedImage(stagingRoot, partialTag);
		check(partial.status === "partial", "a partially-staged image (manifest, no entrypoint) reads as partial");
		let partialLaunchThrew = false;
		try {
			await launchStagedHost({ root: stagingRoot, tag: partialTag, protocolVersion: 5, sessionId: "partial", stateDir: join(sessionsRoot, "partial"), marker: "p", timeoutMs: 3000 });
		} catch {
			partialLaunchThrew = true;
		}
		check(partialLaunchThrew, "launching a partial image fails honestly rather than half-booting");
		check(isAlive(oldHostPid) && isAlive(oldShellPid) && isAlive(fresh.record.hostPid), "diagnosing missing/partial images destroyed no live session");

		// ── 9. observed verdicts match the compact matrix; tmux never invoked ──
		const matrix = buildSkewMatrix([1, 2], [1, 2]);
		console.log(`\nversion/session verdict matrix:\n${renderSkewMatrix(matrix)}\n`);
		const expectMismatch = matrix.find((r) => r.hostVersion === 1 && r.clientVersion === 2);
		const expectCompatible = matrix.find((r) => r.hostVersion === 2 && r.clientVersion === 2);
		check(expectMismatch?.verdict === "version-mismatch" && rejected.status === "rejected", "matrix row (host v1 ← client v2) = version-mismatch matches the observed rejection");
		check(expectCompatible?.verdict === "compatible" && welcome3.status === "welcomed", "matrix row (host v2 ← client v2) = compatible matches the observed welcome");
		check(!existsSync(sentinel), "tmux was NEVER invoked (PATH shim sentinel absent)");
	} finally {
		for (const host of launched) {
			try {
				process.kill(host.record.hostPid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		await delay(400);
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((err) => {
		console.error("\nERROR:", err);
		process.exit(1);
	});
