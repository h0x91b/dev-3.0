/**
 * Tags superseded release archives so the bucket's lifecycle rule can expire them.
 *
 *   bun scripts/release-retention.ts            # dry run: print the plan, change nothing
 *   bun scripts/release-retention.ts --apply    # put the retention tag on superseded dirs
 *
 * Tagging deletes nothing by itself; only `infra/release-bucket-lifecycle.json`, once applied
 * to the bucket, turns a tag into an expiry. The decision lives in src/shared/release-retention.ts.
 */

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CANARY_PLATFORMS } from "../src/shared/canary-publish";
import {
	planRetention,
	RELEASE_PREFIX,
	RETENTION_DAYS,
	RETENTION_TAG,
	RETENTION_TAG_KEY,
	type BucketObject,
	type ManifestRef,
} from "../src/shared/release-retention";

const BUCKET = "h0x91b-releases";
const FORMULA_URL = "https://raw.githubusercontent.com/h0x91b/homebrew-dev3/main/Formula/dev3.rb";
const apply = process.argv.includes("--apply");

function fail(message: string): never {
	console.error(`::error::${message}`);
	process.exit(1);
}

function aws(args: string[], input?: string): string {
	const result = spawnSync("aws", args, { encoding: "utf8", input });
	if (result.status !== 0) fail(`aws ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || "").trim()}`);
	return result.stdout;
}

const manifestKeys = (["canary", "stable"] as const).flatMap((channel) =>
	CANARY_PLATFORMS.map((p) => `${RELEASE_PREFIX}${channel}-${p.os}-${p.arch}-update.json`),
);

function readManifests(): ManifestRef[] {
	return manifestKeys.map((key) => {
		const body = JSON.parse(aws(["s3", "cp", `s3://${BUCKET}/${key}`, "-"])) as { version?: string; sha?: string };
		return { key, version: String(body.version ?? ""), sha: String(body.sha ?? "") };
	});
}

async function readFormulaVersion(): Promise<string> {
	const response = await fetch(FORMULA_URL);
	if (!response.ok) fail(`Homebrew formula answered ${response.status}`);
	return (await response.text()).match(/^\s*version "([^"]+)"/m)?.[1] ?? "";
}

function listObjects(): BucketObject[] {
	const rows = JSON.parse(
		aws(["s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", RELEASE_PREFIX, "--output", "json",
			"--query", "Contents[].[Key,Size,LastModified]"]) || "[]",
	) as [string, number, string][] | null;
	return (rows ?? []).map(([key, size, lastModified]) => ({ key, size, lastModified }));
}

type Tag = { Key: string; Value: string };

function readTags(key: string): Tag[] {
	return (JSON.parse(aws(["s3api", "get-object-tagging", "--bucket", BUCKET, "--key", key, "--output", "json"])) as { TagSet: Tag[] }).TagSet;
}

function writeTag(key: string, value: string): void {
	const tags = readTags(key).filter((t) => t.Key !== RETENTION_TAG_KEY);
	tags.push({ Key: RETENTION_TAG_KEY, Value: value });
	aws(["s3api", "put-object-tagging", "--bucket", BUCKET, "--key", key, "--tagging", JSON.stringify({ TagSet: tags })]);
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

const manifests = readManifests();
const plan = planRetention({
	objects: listObjects(),
	manifests,
	expectedManifestKeys: manifestKeys,
	formulaVersion: await readFormulaVersion(),
});

const kept = plan.dirs.filter((d) => d.keep);
const superseded = plan.dirs.filter((d) => !d.keep);
const lines = [
	`## Release retention (${apply ? "apply" : "dry run"})`,
	"",
	`Protected: ${plan.protectedDirs.join(", ")}`,
	"",
	`| | dirs | objects | size |`,
	`|---|---|---|---|`,
	`| kept | ${kept.length} | ${kept.reduce((n, d) => n + d.objects, 0)} | ${gb(kept.reduce((n, d) => n + d.bytes, 0))} |`,
	...(["canary", "stable"] as const).map((channel) => {
		const rows = superseded.filter((d) => d.channel === channel);
		return `| superseded ${channel} (expires ${RETENTION_DAYS[channel]}d after upload) | ${rows.length} | ${rows.reduce((n, d) => n + d.objects, 0)} | ${gb(rows.reduce((n, d) => n + d.bytes, 0))} |`;
	}),
];

let tagged = 0;
if (apply && superseded.length > 0) {
	const again = readManifests();
	if (again.some((m, i) => m.sha !== manifests[i].sha || m.version !== manifests[i].version)) {
		fail("a manifest changed while planning (a publish is running) — nothing tagged; the next run retries");
	}
	const byDir = new Map<string, string[]>();
	for (const object of listObjects()) {
		const dir = object.key.slice(RELEASE_PREFIX.length).split("/")[0];
		byDir.set(dir, [...(byDir.get(dir) ?? []), object.key]);
	}
	for (const d of superseded) {
		const keys = byDir.get(d.dir) ?? [];
		const value = RETENTION_TAG[d.channel];
		// A whole directory is synced in one pass, so its first key stands for the rest.
		if (keys.length === 0 || readTags(keys[0]).some((t) => t.Key === RETENTION_TAG_KEY && t.Value === value)) continue;
		for (const key of keys) {
			writeTag(key, value);
			tagged += 1;
		}
	}
	lines.push("", `Tagged ${tagged} objects this run.`);
}

const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
