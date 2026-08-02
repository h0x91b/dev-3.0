/**
 * What the OPERATING SYSTEM actually shows for an argv0-named host (seq 1383).
 *
 * Everything else about process naming is a pure string; this file is the only
 * place that proves the string reaches a real process viewer, and it does so on
 * whichever platform it runs on. Its per-platform assertions ARE the documented
 * contract in decision 192 — including the negative ones, because "this column
 * cannot show it" is exactly the fact users need.
 *
 * macOS runs it locally, Linux runs it in the Build workflow, Windows runs it in
 * windows-conpty-package.yml. No physical Windows machine is involved.
 */

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_HOST_PROCESS_NAME } from "../process-naming";

const IDENTITY = `${NATIVE_HOST_PROCESS_NAME} seq:1383 pane:1`;
const PROBE = new URL("./process-naming-probe.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface ProbeReport {
	argv: string[];
	execPath: string;
	platform: string;
	title: { requested: string | null; before: string; after: string; setThrew: boolean };
}

interface LaunchedProbe {
	pid: number;
	report: ProbeReport;
	kill: () => void;
}

async function launchProbe(setTitle?: string): Promise<LaunchedProbe> {
	const child = spawn(process.execPath, [PROBE, "session-host", "dev3-task-probe-pane-1"], {
		argv0: IDENTITY,
		stdio: ["ignore", "pipe", "ignore"],
		env: setTitle ? { ...process.env, DEV3_NAMING_PROBE_TITLE: setTitle } : process.env,
	});
	const report = await new Promise<ProbeReport>((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`probe never reported: ${JSON.stringify(buffer)}`)), 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			try {
				resolve(JSON.parse(buffer.slice(0, newline)) as ProbeReport);
			} catch (err) {
				reject(err as Error);
			}
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
	return {
		pid: child.pid ?? -1,
		report,
		kill: () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		},
	};
}

function ps(pid: number, format: string): string {
	const res = spawnSync("ps", ["-p", String(pid), "-o", format], { encoding: "utf8" });
	return (res.stdout ?? "").trim();
}

/** One CIM property of a live Windows process, or "" when it cannot be read. */
function windowsProcessField(pid: number, field: string): string {
	const res = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").${field}`,
		],
		{ encoding: "utf8" },
	);
	return (res.stdout ?? "").trim();
}

describe(`argv0 process naming on ${process.platform}`, () => {
	let probe: LaunchedProbe | null = null;

	afterEach(() => {
		probe?.kill();
		probe = null;
	});

	it("does not disturb the child's own argv", async () => {
		probe = await launchProbe();
		// argv[0] is normalised back to the real executable, and the host's
		// entrypoint assertion + verb/session-id parsing read argv[1..3].
		expect(probe.report.argv[0]).toBe(probe.report.execPath);
		expect(probe.report.argv[1]).toContain("process-naming-probe.ts");
		expect(probe.report.argv[2]).toBe("session-host");
		expect(probe.report.argv[3]).toBe("dev3-task-probe-pane-1");
		expect(probe.report.argv[0]).not.toContain("seq:1383");
	});

	it.runIf(process.platform !== "win32")("shows the identity in the ps command column", async () => {
		probe = await launchProbe();
		expect(ps(probe.pid, "args=")).toContain(IDENTITY);
	});

	it.runIf(process.platform === "darwin")("shows the identity in macOS `ps -o comm=`", async () => {
		probe = await launchProbe();
		expect(ps(probe.pid, "comm=")).toBe(IDENTITY);
	});

	it.runIf(process.platform === "darwin")(
		"documents the macOS limitation: the kernel accounting name stays the executable",
		async () => {
			probe = await launchProbe();
			// This is what Activity Monitor's Process Name column is built from, so it
			// can never carry a task number without per-task executable copies.
			expect(ps(probe.pid, "ucomm=")).not.toContain("seq:1383");
		},
	);

	it.runIf(process.platform === "linux")(
		"documents the Linux split: /proc/comm keeps the executable, cmdline carries the identity",
		async () => {
			probe = await launchProbe();
			expect(ps(probe.pid, "comm=")).not.toContain("seq:1383");
			expect(ps(probe.pid, "args=")).toContain(IDENTITY);
		},
	);

	it.runIf(process.platform === "win32")(
		"shows the identity in the Task Manager command line, image name unchanged",
		async () => {
			probe = await launchProbe();
			expect(windowsProcessField(probe.pid, "CommandLine")).toContain(IDENTITY);
			// The Details tab's Name column and every image-name contract read this.
			expect(windowsProcessField(probe.pid, "Name").toLowerCase()).not.toContain("seq");
		},
	);

	it("records the process.title probe as evidence, and proves why argv0 is the carrier", async () => {
		const titleProbe = await launchProbe("dev3-terminal-host title-probe");
		probe = titleProbe;
		// Bun accepts the assignment on every platform; where it lands differs, and
		// on macOS it overwrites the argv area IN PLACE — bounded by the original
		// argv0 buffer. A host that set its title would be fighting its own name,
		// which is exactly why the title is only probed here and never written in
		// production code (decision 192).
		expect(titleProbe.report.title.setThrew).toBe(false);
		const observed = process.platform === "win32" ? "n/a" : ps(titleProbe.pid, "comm=");
		console.log(
			`[seq 1383] process.title probe on ${titleProbe.report.platform}: ` +
				`${JSON.stringify(titleProbe.report.title)} psComm=${JSON.stringify(observed)}`,
		);
	});
});
