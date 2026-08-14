/**
 * Runs the real swap script on a real Windows machine against a real running
 * process. Everything here is Windows-only by construction — an assertion
 * authored on macOS about `tasklist` proves nothing.
 *
 * Case 1: the app exits on its own            → script waits for THAT pid, swaps, starts the new tree.
 * Case 2: the app never exits                 → bounded wait, force-closes only what runs from the old
 *                                               tree, swaps anyway. This is Arseny's hang, made to end.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildWindowsSwapScript } from "../script";

if (process.platform !== "win32") {
	console.log("SKIP: windows-update swap e2e runs on Windows only");
	process.exit(0);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
}

function makeCase(label: string) {
	const root = mkdtempSync(join(tmpdir(), `dev3-swap-${label}-`));
	const target = join(root, "app");
	const extraction = join(root, "self-extraction", "temp-hash");
	const newApp = join(extraction, "dev-3.0-canary");
	mkdirSync(join(target, "bin"), { recursive: true });
	mkdirSync(join(newApp, "bin"), { recursive: true });
	writeFileSync(join(target, "bin", "which-version.txt"), "old");
	writeFileSync(join(newApp, "bin", "which-version.txt"), "new");
	// The "launcher" only has to exist and be startable; it records that it ran.
	const launcher = join(target, "bin", "launcher.cmd");
	writeFileSync(join(newApp, "bin", "launcher.cmd"), `@echo off\r\necho started > "${join(root, "launched.txt")}"\r\n`);
	return { root, target, extraction, newApp, launcher, launched: join(root, "launched.txt") };
}

/** Start a process whose EXE lives inside `dir`, so path-scoped kills can find it. */
function startProcessInside(dir: string, seconds: number): number {
	const ping = join(dir, "bin", "sleeper.exe");
	copyFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE"), ping);
	const proc = Bun.spawn([ping, "-n", String(seconds), "127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
	return proc.pid;
}

function runScript(scriptPath: string): string {
	const proc = Bun.spawnSync(["cmd", "/c", scriptPath]);
	return proc.stdout.toString() + proc.stderr.toString();
}

async function runCase(label: string, exitAfterSeconds: number, exitWaitSeconds: number) {
	const c = makeCase(label);
	const pid = startProcessInside(c.target, exitAfterSeconds);
	const scriptPath = join(c.root, "dev3-update.cmd");
	writeFileSync(
		scriptPath,
		buildWindowsSwapScript({
			pid,
			version: "9.9.9",
			targetAppDir: c.target,
			newAppDir: c.newApp,
			extractionDir: c.extraction,
			launcherPath: c.launcher,
			logPath: join(c.root, "dev3-update.log"),
			exitWaitSeconds,
			removeRetries: 5,
		}),
	);

	const out = runScript(scriptPath);
	console.log(`--- ${label} output ---\n${out}\n--- end ---`);

	check(`${label}: waits on the pid it was given`, out.includes(`waiting for dev3 to exit (pid ${pid})`));
	check(`${label}: prints progress (console is never blank)`, /still running after \d+s|removing the old version/.test(out));
	check(`${label}: swap landed`, existsSync(join(c.target, "bin", "which-version.txt")) &&
		readFileSync(join(c.target, "bin", "which-version.txt"), "utf8").trim() === "new",
		"target still holds the old tree");
	check(`${label}: reported completion`, out.includes("update complete"));
	check(`${label}: never left the extraction scratch behind`, !existsSync(c.extraction));
	// The launcher is started detached; give it a moment.
	await Bun.sleep(2000);
	check(`${label}: started the new launcher`, existsSync(c.launched));
	return { out, pid };
}

const clean = await runCase("exits-cleanly", 4, 60);
check("exits-cleanly: never needed the force-close path", !clean.out.includes("did not exit after"));
// A wait that does not actually wait is the bug `timeout` caused: it spun 28 times in
// under 5 seconds. One tick per second means at most a handful before a 4s process ends.
const ticks = clean.out.match(/still running after/g)?.length ?? 0;
check("exits-cleanly: each tick is a real second, not a busy spin", ticks > 0 && ticks <= 8, `${ticks} ticks`);

const stuck = await runCase("never-exits", 60, 3);
check("never-exits: gave up waiting instead of hanging forever", stuck.out.includes("did not exit after 3s"));
check(
	"never-exits: the stuck process is gone",
	Bun.spawnSync(["tasklist", "/FI", `PID eq ${stuck.pid}`, "/NH"]).stdout.toString().includes(String(stuck.pid)) === false,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
