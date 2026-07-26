/**
 * Opt-in duration + fault regression for headless (`dev3 remote`) mode.
 *
 * Windows over SSH produced a desktop process that lived ~906 s with a dead
 * WebView2 controller and then died inside libNativeWrapper. `dev3 remote` is the
 * documented answer for a machine with no interactive desktop, so it must never
 * be able to inherit that failure: it must serve for longer than that window
 * without ever constructing a BrowserWindow, and it must ignore the desktop
 * renderer-readiness watchdog entirely (here it is pinned to 1 ms — a value that
 * would kill any desktop launch instantly).
 *
 * Deliberately NOT part of `bun run test`: it runs for 16 minutes by default.
 *
 *   bun run test:headless-soak                    # 16 min (covers the 906 s window)
 *   DEV3_SOAK_MS=60000 bun run test:headless-soak # quick smoke
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SOAK_MS = Number(process.env.DEV3_SOAK_MS ?? 16 * 60 * 1000);
const PROBE_INTERVAL_MS = 15_000;
const START_TIMEOUT_MS = 120_000;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

const home = mkdtempSync(resolve(tmpdir(), "dev3-headless-soak-"));

const child = spawn(
	process.execPath,
	["src/cli/main.ts", "remote", "start", "--no-detach", "--no-tunnel"],
	{
		cwd: REPO_ROOT,
		env: {
			...process.env,
			HOME: home,
			// 0 = pick a free port, so concurrent runs never collide.
			DEV3_REMOTE_PORT: "0",
			// Would abort any desktop launch immediately; headless must not care.
			DEV3_RENDERER_READY_TIMEOUT_MS: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

let output = "";
let exitCode: number | null = null;
let exitSignal: NodeJS.Signals | null = null;
child.stdout?.on("data", (chunk) => { output += String(chunk); });
child.stderr?.on("data", (chunk) => { output += String(chunk); });
child.on("exit", (code, signal) => { exitCode = code; exitSignal = signal; });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The banner prints `http://<host>:<port>/`; that URL is the health probe. */
function accessUrl(): string | null {
	return output.match(/http:\/\/[\d.]+:(\d+)\//)?.[0] ?? null;
}

async function main(): Promise<void> {
	console.log(`[soak] headless remote, ${Math.round(SOAK_MS / 1000)}s, isolated home ${home}`);

	const startDeadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < startDeadline && accessUrl() === null && exitCode === null) {
		await sleep(500);
	}
	const url = accessUrl();
	check("headless server started and printed an access URL", url !== null, output.slice(-600));
	if (url === null) return;

	check("did not exit during startup", exitCode === null, `exit=${exitCode}`);

	const soakDeadline = Date.now() + SOAK_MS;
	let probes = 0;
	let served = 0;
	while (Date.now() < soakDeadline) {
		await sleep(PROBE_INTERVAL_MS);
		probes++;
		if (exitCode !== null) break;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			// Any HTTP answer proves the listener is alive; auth may redirect.
			if (res.status > 0) served++;
			await res.arrayBuffer();
		} catch { /* counted as a miss below */ }
		if (probes % 8 === 0) {
			console.log(`  … ${Math.round((Date.now() - (soakDeadline - SOAK_MS)) / 1000)}s, ${served}/${probes} probes served`);
		}
	}

	check(`survived the whole soak (${Math.round(SOAK_MS / 1000)}s)`, exitCode === null, `exit=${exitCode} signal=${exitSignal}`);
	check("answered every health probe", served === probes, `${served}/${probes}`);
	check("never created a desktop window", !/window-manager|Window created/.test(output));
	check(
		"never took the desktop renderer-unavailable exit",
		!output.includes("DEV3_DESKTOP_RENDERER_UNAVAILABLE"),
	);

	child.kill("SIGTERM");
	const stopDeadline = Date.now() + 30_000;
	while (Date.now() < stopDeadline && exitCode === null && exitSignal === null) await sleep(250);
	check("shut down on SIGTERM without waiting for a renderer", exitCode !== null || exitSignal !== null);
}

try {
	await main();
} finally {
	if (exitCode === null) child.kill("SIGKILL");
	try {
		console.log(`[soak] remote log tail:\n${readFileSync(resolve(home, ".dev3.0/remote/remote.log"), "utf8").split("\n").slice(-5).join("\n")}`);
	} catch { /* no log written — the checks above already say so */ }
	rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n[soak] FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
	process.exit(1);
}
console.log("\n[soak] PASS");
