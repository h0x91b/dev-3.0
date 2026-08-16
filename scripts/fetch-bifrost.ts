/**
 * Download the pinned proxy-sidecar binary for this machine's target into
 * `vendor/bifrost/` (git-ignored), verifying its SHA-256 against the tracked
 * `scripts/bifrost-pinned.json`.
 *
 *   bun scripts/fetch-bifrost.ts                  verify against the pin (release CI)
 *   bun scripts/fetch-bifrost.ts --record         record the hash for a new version
 *   bun scripts/fetch-bifrost.ts --record --all   record every shipped target at once
 *
 * Without `--record` an unpinned target is a hard failure: shipping a binary
 * nobody checked is exactly the supply-chain step this script exists to avoid.
 * `--all` exists because release CI builds five targets and each runner can only
 * hash its own — a pin file recorded one machine at a time fails four of them.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	BIFROST_LICENSE_URL,
	BIFROST_TARGETS,
	BIFROST_VERSION,
	bifrostPinKey,
	bifrostTarget,
} from "../src/shared/bifrost-release";

const ROOT = resolve(import.meta.dir, "..");
const VENDOR_DIR = `${ROOT}/vendor/bifrost`;
// Tracked, unlike vendor/ — the whole point of a pin is that it lives in git.
const PIN_FILE = `${ROOT}/scripts/bifrost-pinned.json`;

interface PinFile {
	version: string;
	/** `<platform>-<arch>` → lowercase hex SHA-256. */
	sha256: Record<string, string>;
}

function readPins(): PinFile {
	if (!existsSync(PIN_FILE)) return { version: BIFROST_VERSION, sha256: {} };
	return JSON.parse(readFileSync(PIN_FILE, "utf-8")) as PinFile;
}

async function sha256Of(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`[fetch-bifrost] ${url} answered ${res.status}`);
		process.exit(1);
	}
	return new Uint8Array(await res.arrayBuffer());
}

/** Record every shipped target's hash in one pass. Downloads only — the binary
 *  this machine runs is still fetched by the single-target path below. */
async function recordAll(): Promise<void> {
	const sha256: Record<string, string> = {};
	for (const { platform, arch } of BIFROST_TARGETS) {
		const target = bifrostTarget(platform, arch);
		if (!target) {
			console.error(`[fetch-bifrost] no published build for ${platform}/${arch}`);
			process.exit(1);
		}
		const bytes = await sha256Of(target.url);
		const key = bifrostPinKey(platform, arch);
		sha256[key] = createHash("sha256").update(bytes).digest("hex");
		console.log(`[fetch-bifrost] recorded ${key} ${sha256[key]} (${bytes.length} bytes)`);
	}
	writeFileSync(PIN_FILE, `${JSON.stringify({ version: BIFROST_VERSION, sha256 }, null, 2)}\n`);
}

async function main(): Promise<void> {
	const record = process.argv.includes("--record");
	if (process.argv.includes("--all")) {
		if (!record) {
			console.error("[fetch-bifrost] --all only makes sense with --record");
			process.exit(1);
		}
		await recordAll();
		return;
	}
	const target = bifrostTarget(process.platform, process.arch);
	if (!target) {
		console.error(`[fetch-bifrost] no published build for ${process.platform}/${process.arch}`);
		process.exit(1);
	}

	const res = await fetch(target.url);
	if (!res.ok) {
		console.error(`[fetch-bifrost] ${target.url} answered ${res.status}`);
		process.exit(1);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	const digest = createHash("sha256").update(bytes).digest("hex");

	const pins = readPins();
	const key = bifrostPinKey(process.platform, process.arch);
	const pinned = pins.version === BIFROST_VERSION ? pins.sha256[key] : undefined;

	if (record) {
		const next: PinFile = {
			version: BIFROST_VERSION,
			sha256: { ...(pins.version === BIFROST_VERSION ? pins.sha256 : {}), [key]: digest },
		};
		writeFileSync(PIN_FILE, `${JSON.stringify(next, null, 2)}\n`);
		console.log(`[fetch-bifrost] recorded ${key} ${digest}`);
	} else if (!pinned) {
		console.error(`[fetch-bifrost] ${key} is not pinned for ${BIFROST_VERSION} — run with --record after reviewing the build`);
		process.exit(1);
	} else if (pinned !== digest) {
		console.error(`[fetch-bifrost] checksum mismatch for ${key}\n  pinned:   ${pinned}\n  download: ${digest}`);
		process.exit(1);
	}

	// The licence travels with the binary: dev3 redistributes it inside the app.
	const license = await fetch(BIFROST_LICENSE_URL);
	if (!license.ok) {
		console.error(`[fetch-bifrost] ${BIFROST_LICENSE_URL} answered ${license.status}`);
		process.exit(1);
	}

	mkdirSync(VENDOR_DIR, { recursive: true });
	writeFileSync(`${VENDOR_DIR}/LICENSE-bifrost.txt`, await license.text());
	const binaryPath = `${VENDOR_DIR}/${target.binaryName}`;
	writeFileSync(binaryPath, bytes);
	if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
	console.log(`[fetch-bifrost] ${BIFROST_VERSION} → ${binaryPath} (${bytes.length} bytes)`);
}

if (import.meta.main) await main();
