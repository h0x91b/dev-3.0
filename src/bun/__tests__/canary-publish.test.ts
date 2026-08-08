/**
 * The hourly publisher's skip decision. Every branch here is a way to waste a full
 * sign-and-notarize cycle, or to stop publishing entirely, without anything going red.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decidePlatformPublish, CANARY_PLATFORMS } from "../../shared/canary-publish";

const HEAD = "35c68a90fbf37fde8c9288976e30d7a8d5b329e5";

const WORKFLOW = readFileSync(
	fileURLToPath(new URL("../../../.github/workflows/canary-publish.yml", import.meta.url)),
	"utf8",
);

describe("deciding whether a platform needs an canary build", () => {
	it("builds when no manifest has ever been published", () => {
		expect(decidePlatformPublish({ kind: "absent" }, HEAD)).toEqual({
			build: true,
			reason: "no canary manifest has ever been published for this platform",
		});
	});

	it("skips when the published manifest is already at this commit", () => {
		const decision = decidePlatformPublish({ kind: "present", body: JSON.stringify({ sha: HEAD }) }, HEAD);
		expect(
			decision,
			"an unchanged main must SKIP. If this builds, the cron signs and notarizes a full release every hour for no change.",
		).toMatchObject({ build: false });
	});

	it("builds when the published manifest is at an older commit", () => {
		expect(decidePlatformPublish({ kind: "present", body: JSON.stringify({ sha: "cafe1234deadbeef" }) }, HEAD))
			.toMatchObject({ build: true });
	});

	// THE TRAP, and it is why `absent` is a separate kind rather than an HTTP status. On this
	// bucket a GET for a nonexistent key answers 403 AccessDenied, because anonymous callers
	// have no s3:ListBucket — measured against the live bucket, invented key included.
	// Mapping that to "absent" would rebuild everything hourly forever after a policy change;
	// mapping it to "present" would stop publishing forever. Only a probe that can PROVE
	// absence may say so.
	it("FAILS on an undecidable read rather than treating it as never-published", () => {
		const decision = decidePlatformPublish({ kind: "undecidable", detail: "403 AccessDenied" }, HEAD);
		expect(
			decision,
			"an undecidable read must be an ERROR, never a build. A missing key on this bucket answers 403 to an anonymous caller, so treating an unproven absence as absent turns one bucket-policy change into a full sign-and-notarize cycle every hour, forever.",
		).toMatchObject({ error: expect.stringContaining("403 AccessDenied") });
	});

	it("FAILS on a server error rather than guessing", () => {
		expect(decidePlatformPublish({ kind: "undecidable", detail: "503 Slow Down" }, HEAD)).toMatchObject({
			error: expect.stringContaining("503"),
		});
	});

	it("quotes what it actually saw, so absent and unreachable stay distinguishable afterwards", () => {
		const decision = decidePlatformPublish({ kind: "undecidable", detail: "500 Internal Error" }, HEAD);
		expect(
			"error" in decision && decision.error,
			"the failure must quote the probe's own words. Without them the operator cannot tell a transient outage from a permissions change, which are the two causes and have different fixes.",
		).toContain("500 Internal Error");
	});

	it("names s3:ListBucket in the failure, because that is the fix for the likely cause", () => {
		const decision = decidePlatformPublish({ kind: "undecidable", detail: "403 AccessDenied" }, HEAD);
		expect(
			"error" in decision && decision.error,
			"the undecidable failure must name the permission that makes absence provable. Without it the operator reads 'could not be read', checks that the bucket is up, finds it is, and has nowhere to go next.",
		).toContain("s3:ListBucket");
	});

	it("FAILS on a manifest that is not JSON, because a truncated manifest means a broken publish", () => {
		expect(decidePlatformPublish({ kind: "present", body: "<?xml version" }, HEAD)).toMatchObject({
			error: expect.stringContaining("not valid JSON"),
		});
	});

	it("builds when the published manifest predates the sha field", () => {
		// Cannot be compared, so it cannot be trusted as current. Builds exactly once,
		// after which the field is present.
		expect(decidePlatformPublish({ kind: "present", body: JSON.stringify({ version: "1.42.0" }) }, HEAD))
			.toMatchObject({ build: true });
	});

	it("covers every platform the workflow publishes", () => {
		expect(
			CANARY_PLATFORMS.map((p) => `${p.os}-${p.arch}`),
			"the platform list must match the caller jobs in canary-publish.yml. A platform present in the workflow but missing here is never probed, so it publishes every hour regardless of whether main moved.",
		).toEqual(["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "win-x64"]);
	});

	// The token, not the platform. `windows` is what every runner label, workflow filename and
	// English sentence says, and it would build a perfectly well-formed
	// `canary-windows-x64-update.json` that no client ever fetches — green run, populated
	// bucket, zero Windows users updated, nothing anywhere saying why.
	it("spells Windows the way the updater spells it, not the way the runner does", () => {
		const updater = readFileSync(
			fileURLToPath(new URL("../updater.ts", import.meta.url)),
			"utf8",
		);
		expect(
			updater,
			"getPlatformPrefix no longer maps win32 to 'win'. The published manifest key and the key the app asks for are built from two different files, and this is the only thing tying them together. Fix: whichever side changed, change the other in the same commit.",
		).toMatch(/"win32"\s*\?\s*"win"/);
		expect(
			CANARY_PLATFORMS.map((p) => p.os),
			"a platform is declared as 'windows'. The in-app updater fetches `{channel}-win-{arch}-update.json`, so publishing under 'windows' writes a manifest nobody reads.",
		).not.toContain("windows");
	});

	// A platform can be probed and never built, which is the quieter half of the same bug: the
	// decide job reports BUILD, nothing consumes the output, and the run is green with that
	// platform silently absent from the feed forever.
	it("gives every probed platform a caller job that actually builds it", () => {
		const missing = CANARY_PLATFORMS.map((p) => `${p.os}-${p.arch}`).filter(
			(key) => !new RegExp(`^ {2}build-${key}:$`, "m").test(WORKFLOW),
		);
		expect(
			missing,
			`${missing.join(", ")} is probed by the decide job but has no \`build-<platform>\` caller job in canary-publish.yml. The probe would report BUILD, nothing would consume it, and that platform would never appear in the feed — with the run green every hour. Fix: add the caller job.`,
		).toEqual([]);
	});
});

/**
 * THE BOOTSTRAP LOOP, found by probing the live bucket rather than by reading the code.
 *
 * A missing key on h0x91b-releases answers 403 AccessDenied to an anonymous caller — proven
 * against the real bucket, invented key included — and this workflow refuses to build on an
 * unproven absence. Probed anonymously it therefore deadlocks on its own first run: 403 →
 * refuse → no manifest is ever written → 403 again, every hour, forever, red every time.
 * Two things break the loop, and both are pinned here.
 */
describe("the publisher can reach its own first publish", () => {
	const SCRIPT = readFileSync(
		fileURLToPath(new URL("../../../scripts/decide-canary-publish.ts", import.meta.url)),
		"utf8",
	);

	it("probes the feed with credentials, not anonymously", () => {
		expect(
			SCRIPT,
			"the probe went back to an unauthenticated fetch of the feed URL. On this bucket a MISSING key answers 403, not 404, so absence can never be proven and the first publish is unreachable — the cron then fails every hour forever. Fix: read the object through the aws CLI with the publishing credentials.",
		).toMatch(/aws/);
		expect(
			/fetch\(/.test(SCRIPT),
			"an anonymous fetch is back in the probe. It cannot distinguish a missing key from a denied one on this bucket. Fix: use the authenticated read.",
		).toBe(false);
	});

	it("carries the credentials into the probing step", () => {
		const decide = /^ {2}decide:$[\s\S]*?^ {2}[a-z-]+:$/m.exec(WORKFLOW)?.[0] ?? WORKFLOW;
		expect(
			decide,
			"the decide job no longer passes AWS credentials, so the authenticated probe falls back to an anonymous read and every platform reports undecidable. Fix: keep AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on the probe step.",
		).toMatch(/AWS_ACCESS_KEY_ID/);
	});

	it("keeps a human-pressed escape for a channel that has never published", () => {
		expect(
			WORKFLOW,
			"the `force` dispatch input is gone. It is the only way to seed a channel whose feed is empty when the probe itself cannot run — without it a permissions problem has no manual way out. Fix: restore the workflow_dispatch input and FORCE_PUBLISH.",
		).toMatch(/force:/);
		expect(
			SCRIPT,
			"the script no longer reads FORCE_PUBLISH, so the dispatch input is decoration and pressing it does nothing.",
		).toMatch(/FORCE_PUBLISH/);
	});

	it("says loudly that a forced run compared nothing", () => {
		expect(
			SCRIPT,
			"a forced run must announce that the feed was NOT compared. Silently publishing four platforms on a human's say-so looks identical in the log to a normal publish, and the next reader will believe the feed said so.",
		).toMatch(/::warning::FORCED/);
	});
});

/**
 * The Windows proof gates every publish, so it must run whenever ANY platform publishes —
 * and only then. Getting the condition wrong is invisible in both directions: too narrow and
 * a platform publishes ungated, too broad and a quiet hour pays for a full Windows packaging
 * run that gates nothing (~24 of them a day, since main is quiet most hours).
 */
describe("the Windows proof is scoped to hours that actually publish", () => {
	const gate = /^ {2}windows-proof:$[\s\S]*?^ {4}uses:/m.exec(WORKFLOW)?.[0] ?? "";

	it("is conditional at all, rather than running on every quiet hour", () => {
		expect(
			gate,
			"the windows-proof job in canary-publish.yml has no `if:`, so it packages Windows every hour whether or not anything publishes. Fix: gate it on the decide outputs — see the comment above the job.",
		).toMatch(/^ {4}if:/m);
	});

	it("names every platform decide emits, so none loses its gate silently", () => {
		const missing = CANARY_PLATFORMS.map((p) => `${p.os}-${p.arch}`).filter(
			(key) => !gate.includes(`needs.decide.outputs.${key} == 'true'`),
		);
		expect(
			missing,
			`the windows-proof condition does not mention ${missing.join(", ")}. A platform absent from it publishes on an hour when the proof was skipped — GitHub skips a job whose \`needs\` was skipped, so the build would be skipped too and that platform would stop publishing entirely. Fix: add the missing term to the \`if:\` in canary-publish.yml.`,
		).toEqual([]);
	});
});
