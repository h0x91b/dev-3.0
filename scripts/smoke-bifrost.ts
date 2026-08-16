/**
 * Start the vendored proxy sidecar against a dev3-generated config and prove it
 * serves: health answers, an unauthenticated call is refused, an authenticated
 * one is not. Run by release CI right after the download, so a binary that
 * cannot boot never reaches a build.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bifrostTarget } from "../src/shared/bifrost-release";
import { buildSidecarConfig } from "../src/shared/model-catalog";

const ROOT = join(import.meta.dir, "..");
const SESSION_KEY = "sk-bf-smoke-0000000000000000";

function fail(message: string, output = ""): never {
	console.error(`[smoke-bifrost] ${message}${output ? `\n${output}` : ""}`);
	process.exit(1);
}

const target = bifrostTarget(process.platform, process.arch);
if (!target) fail(`no published build for ${process.platform}/${process.arch}`);

const binary = join(ROOT, "vendor", "bifrost", target.binaryName);
const dir = mkdtempSync(join(tmpdir(), "dev3-bifrost-smoke-"));
const port = 47990 + Math.floor(process.pid % 100);

writeFileSync(
	join(dir, "config.json"),
	JSON.stringify(
		buildSidecarConfig(
			{
				providers: [{ id: "p1", kind: "openai", label: "OpenAI" }],
				models: [{ id: "m1", providerId: "p1", name: "smoke", modelId: "gpt-4o-mini" }],
			},
			dir,
		),
		null,
		2,
	),
);

const proc = Bun.spawn([binary, "-host", "127.0.0.1", "-port", String(port), "-app-dir", dir, "-log-level", "warn", "-log-style", "json"], {
	env: {
		...process.env,
		DEV3_BIFROST_VIRTUAL_KEY: SESSION_KEY,
		DEV3_BIFROST_ENCRYPTION_KEY: "0".repeat(64),
		DEV3_LLM_KEY_OPENAI: "sk-smoke-not-a-real-key",
	},
	stdout: "pipe",
	stderr: "pipe",
});

const base = `http://127.0.0.1:${port}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
	await Bun.sleep(500);
	try {
		ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
	} catch {
		/* not up yet */
	}
}

async function shutdown(): Promise<string> {
	proc.kill();
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	rmSync(dir, { recursive: true, force: true });
	return `${out}\n${err}`.trim().split("\n").slice(-20).join("\n");
}

if (!ready) fail("the proxy never answered /health", await shutdown());

const anonymous = await fetch(`${base}/v1/models`);
const authenticated = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${SESSION_KEY}` } });
const output = await shutdown();

// The upstream key is deliberately fake, so an authenticated call reaches the
// provider and fails there — anything but 401 means our key was accepted.
if (anonymous.status !== 401) fail(`an unauthenticated call was not refused (${anonymous.status})`, output);
if (authenticated.status === 401 && !(await authenticated.clone().text()).includes("invalid_api_key")) {
	fail("the local session key was rejected", output);
}

console.log(`[smoke-bifrost] ok — booted, refused an anonymous call, accepted the session key (port ${port})`);
