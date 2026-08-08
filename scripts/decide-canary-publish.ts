/**
 * Probes the published canary feed and writes one GitHub output per platform.
 *
 * Thin on purpose: every rule lives in `src/shared/canary-publish.ts` where it is unit
 * tested, and this file only does the I/O — read the object, print, write outputs, set the
 * exit code.
 *
 * THE READ IS AUTHENTICATED, and that is not an implementation detail. `h0x91b-releases`
 * grants no anonymous `s3:ListBucket`, so an anonymous GET for a key that does not exist
 * answers **403 AccessDenied**, exactly like a key hidden behind a broken policy — measured
 * against the live bucket, including a deliberately invented key. Probing that way made the
 * bootstrap unreachable: 403 is (correctly) refused, no build runs, no manifest appears, and
 * the next hour reads 403 again, forever. Reading with the publishing credentials makes a
 * missing key answer 404, so "absent" is a fact rather than a guess.
 */

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { decidePlatformPublish, CANARY_PLATFORMS, type FeedProbe } from "../src/shared/canary-publish";

const BUCKET_PREFIX = "s3://h0x91b-releases/dev-3.0";

const headSha = process.env.GITHUB_SHA ?? "";
if (!headSha) {
	console.error("::error::GITHUB_SHA is unset, so there is nothing to compare the feed against");
	process.exit(1);
}

/**
 * Bootstrap escape, used when the feed genuinely has nothing yet and a human says so.
 * Deliberately NOT a code path that can decide on its own: it is a `workflow_dispatch`
 * input, so pressing it is an act, and the run says loudly that nothing was compared.
 */
const forced = process.env.FORCE_PUBLISH === "true";

/** One authenticated read. Absent is claimed only on an explicit 404 / NoSuchKey. */
function probe(os: string, arch: string): FeedProbe {
	const result = spawnSync(
		"aws",
		["s3", "cp", `${BUCKET_PREFIX}/canary-${os}-${arch}-update.json`, "-"],
		{ encoding: "utf8" },
	);
	if (result.error) {
		return { kind: "undecidable", detail: `the aws CLI could not be run: ${result.error.message}` };
	}
	if (result.status === 0) return { kind: "present", body: result.stdout };

	const stderr = (result.stderr || "").trim();
	if (/\b404\b|NoSuchKey|Not Found|does not exist/i.test(stderr)) return { kind: "absent" };
	return { kind: "undecidable", detail: stderr || `aws exited ${result.status} without saying why` };
}

const outputPath = process.env.GITHUB_OUTPUT;
let failures = 0;
let builds = 0;

for (const { os, arch } of CANARY_PLATFORMS) {
	const key = `${os}-${arch}`;
	const decision = forced
		? ({ build: true, reason: "forced by workflow_dispatch — the feed was NOT compared" } as const)
		: decidePlatformPublish(probe(os, arch), headSha);

	if ("error" in decision) {
		console.error(`::error::${key}: ${decision.error}`);
		failures++;
		continue;
	}
	console.log(`${key}: ${decision.build ? "BUILD" : "skip"} — ${decision.reason}`);
	if (decision.build) builds++;
	if (outputPath) appendFileSync(outputPath, `${key}=${decision.build}\n`);
}

if (forced) {
	console.log("::warning::FORCED publish — every platform builds and nothing was compared against the feed. Use this only to seed a channel that has never published.");
}
if (failures > 0) {
	console.error(`::error::${failures} of ${CANARY_PLATFORMS.length} platforms could not be decided — refusing to publish a partial guess`);
	process.exit(1);
}
if (!forced && builds === 0) {
	console.log("::notice::main has not moved since the last canary publish on any platform — nothing to build");
}
