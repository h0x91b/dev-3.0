import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	KEEP_NEWEST,
	planRetention,
	RETENTION_DAYS,
	RETENTION_TAG,
	RETENTION_TAG_KEY,
	type BucketObject,
	type ManifestRef,
} from "../../shared/release-retention";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (n: number) => n.toString(16).padStart(40, "0");
const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString();

function dir(name: string, uploaded: string, files = 2): BucketObject[] {
	return Array.from({ length: files }, (_, i) => ({ key: `dev-3.0/${name}/file-${i}`, size: 100, lastModified: uploaded }));
}

const CURRENT_CANARY = sha(999);
const KEYS = ["dev-3.0/canary-macos-arm64-update.json", "dev-3.0/stable-macos-arm64-update.json"];
const MANIFESTS: ManifestRef[] = [
	{ key: KEYS[0], version: "1.57.1+canary.00000999", sha: CURRENT_CANARY },
	{ key: KEYS[1], version: "1.57.1", sha: sha(500) },
];

function plan(objects: BucketObject[], overrides: Partial<Parameters<typeof planRetention>[0]> = {}) {
	return planRetention({ objects, manifests: MANIFESTS, expectedManifestKeys: KEYS, formulaVersion: "1.57.1", ...overrides });
}

const verdict = (p: ReturnType<typeof planRetention>, name: string) => p.dirs.find((d) => d.dir === name);

describe("planRetention", () => {
	it("never marks the build a manifest points at, however old it is", () => {
		const fillers = Array.from({ length: KEEP_NEWEST.canary }, (_, i) => dir(sha(i + 1), day(20))).flat();
		const p = plan([...dir(CURRENT_CANARY, day(-300)), ...fillers, ...dir("v1.57.1", day(-300)), ...dir("v1.50.0", day(10)), ...dir("v1.51.0", day(11)), ...dir("v1.52.0", day(12))]);
		expect(verdict(p, CURRENT_CANARY)?.keep).toBe(`sha in ${KEYS[0]}`);
		expect(verdict(p, "v1.57.1")?.keep).toBe(`version in ${KEYS[1]}`);
	});

	it("protects the Homebrew formula's version even when no manifest names it", () => {
		const p = plan([...dir("v1.40.0", day(-200)), ...Array.from({ length: 5 }, (_, i) => dir(`v1.5${i}.0`, day(i))).flat()], { formulaVersion: "1.40.0" });
		expect(verdict(p, "v1.40.0")?.keep).toBe("Homebrew formula version");
	});

	it("keeps the newest dirs of each channel as a second line of defence", () => {
		const canary = Array.from({ length: KEEP_NEWEST.canary + 2 }, (_, i) => dir(sha(i + 1), day(i))).flat();
		const p = plan(canary);
		const marked = p.dirs.filter((d) => d.channel === "canary" && !d.keep).map((d) => d.dir);
		expect(marked).toEqual([sha(1), sha(2)]);
	});

	it("marks only superseded archive dirs, never the root feed or unknown dirs", () => {
		const objects = [
			{ key: "dev-3.0/stable-macos-arm64-dev-3.0.app.tar.zst", size: 1, lastModified: day(-500) },
			{ key: "dev-3.0/canary-macos-arm64-update.json", size: 1, lastModified: day(-500) },
			...dir("not-a-release", day(-500)),
			...dir(sha(7), day(-500)),
		];
		const p = plan(objects, { formulaVersion: "1.57.1" });
		expect(p.dirs.map((d) => d.dir)).toEqual([sha(7)]);
	});

	it("refuses to plan when a manifest was not read", () => {
		expect(() => plan([], { manifests: MANIFESTS.slice(0, 1) })).toThrow(/manifests not read: dev-3.0\/stable-macos-arm64-update.json/);
	});

	it("refuses to plan on a manifest without a full sha", () => {
		expect(() => plan([], { manifests: [{ ...MANIFESTS[0], sha: "e498d788" }, MANIFESTS[1]] })).toThrow(/no full commit sha/);
	});

	it("refuses to plan when the formula version is unreadable", () => {
		expect(() => plan([], { formulaVersion: "" })).toThrow(/formula version unreadable/);
	});
});

describe("lifecycle rule in infra/release-bucket-lifecycle.json", () => {
	const rules = JSON.parse(readFileSync(join(ROOT, "infra/release-bucket-lifecycle.json"), "utf8")).Rules as {
		Filter: { And?: { Prefix: string; Tags: { Key: string; Value: string }[] }; Prefix?: string };
		Expiration?: { Days: number };
	}[];

	it("expires nothing that is not tagged", () => {
		for (const rule of rules.filter((r) => r.Expiration)) {
			expect(rule.Filter.And?.Tags.map((t) => t.Key)).toEqual([RETENTION_TAG_KEY]);
		}
	});

	it("uses the same tags and clocks as the planner", () => {
		for (const channel of ["canary", "stable"] as const) {
			const rule = rules.find((r) => r.Filter.And?.Tags.some((t) => t.Value === RETENTION_TAG[channel]));
			expect(rule?.Expiration?.Days, channel).toBe(RETENTION_DAYS[channel]);
			expect(rule?.Filter.And?.Prefix).toBe("dev-3.0/");
		}
	});
});
