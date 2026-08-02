import { describe, expect, it } from "vitest";
import {
	collectNativeProcesses,
	renderNativeProcesses,
	type NativeProcessRow,
	type ProcessInventoryDeps,
} from "../doctor-processes";

const SESSION = "dev3-task-11111111-2222-3333-4444-555555555555-pane-1";
const OTHER = "dev3-task-99999999-2222-3333-4444-555555555555-pane-3";

function record(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		sessionId: SESSION,
		paneId: `${SESSION}:0`,
		identity: { seq: "1383", paneId: "pane-1" },
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: {
			pid: 501,
			executable: "/Users/me/.dev3.0/native-host-images/tag/dev3-terminal-host",
			startSignature: "501@t0",
		},
		shell: { pid: 502, command: ["/bin/zsh", "-l"], startSignature: "502@t0" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-08-02T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
		...overrides,
	});
}

function deps(files: Record<string, string>, alive: number[] = []): ProcessInventoryDeps {
	return {
		sessionsDir: "/sessions",
		listDirs: () => Object.keys(files),
		readFile: (path) => {
			const segments = path.split("/");
			const session = segments[segments.length - 2]!;
			const text = files[session];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		isAlive: (pid) => alive.includes(pid),
	};
}

describe("doctor --processes inventory", () => {
	it("reports a live session as one host row and one shell row", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record() }, [501, 502]));
		expect(rows).toEqual<NativeProcessRow[]>([
			{
				sessionId: SESSION,
				seq: "1383",
				paneId: "pane-1",
				role: "host",
				pid: 501,
				parentPid: null,
				executable: "dev3-terminal-host",
				state: "alive",
			},
			{
				sessionId: SESSION,
				seq: "1383",
				paneId: "pane-1",
				role: "shell",
				pid: 502,
				parentPid: 501,
				executable: "zsh",
				state: "alive",
			},
		]);
	});

	it("marks a record whose process is gone as stale, per process", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record() }, [501]));
		expect(rows.map((r) => [r.role, r.state])).toEqual([
			["host", "alive"],
			["shell", "stale"],
		]);
	});

	it("reports an unreadable session directory as unknown instead of hiding it", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: "{ not json" }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ sessionId: SESSION, state: "unknown", seq: null, pid: null });
	});

	it("treats a foreign schema version as unknown, never adopting it", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record({ schemaVersion: 99 }) }));
		expect(rows[0]!.state).toBe("unknown");
	});

	it("has no task number for a session with no identity block (pre-1383 or non-task)", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record({ identity: undefined }) }, [501, 502]));
		expect(rows.every((r) => r.seq === null)).toBe(true);
		expect(renderNativeProcesses(rows)).toContain("—");
	});

	it("still names the pane of a pre-1383 record, from its session id", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record({ identity: undefined }) }, [501, 502]));
		expect(rows.every((r) => r.paneId === "pane-1")).toBe(true);
	});

	it("has no pane for a session id that carries none", () => {
		const bare = "dev3-task-11111111-2222-3333-4444-555555555555";
		const rows = collectNativeProcesses(deps({ [bare]: record({ sessionId: bare, identity: undefined }) }));
		expect(rows.every((r) => r.paneId === null)).toBe(true);
	});

	it("returns nothing when the native session root does not exist", () => {
		expect(
			collectNativeProcesses({
				sessionsDir: "/nope",
				listDirs: () => {
					throw new Error("ENOENT");
				},
				readFile: () => "",
				isAlive: () => false,
			}),
		).toEqual([]);
	});

	it("orders by task number numerically, host before its shell", () => {
		const rows = collectNativeProcesses(
			deps({
				[OTHER]: record({ sessionId: OTHER, identity: { seq: "205", paneId: "pane-3" } }),
				[SESSION]: record(),
			}),
		);
		expect(rows.map((r) => `${r.seq}:${r.role}`)).toEqual(["205:host", "205:shell", "1383:host", "1383:shell"]);
	});

	it("sorts unidentified sessions last", () => {
		const rows = collectNativeProcesses(
			deps({ [SESSION]: record({ identity: undefined }), [OTHER]: record({ sessionId: OTHER }) }),
		);
		expect(rows[0]!.seq).toBe("1383");
		expect(rows[rows.length - 1]!.seq).toBeNull();
	});
});

describe("doctor --processes output is safe to paste into a bug report", () => {
	const secretRecord = record({
		host: {
			pid: 501,
			executable: "/Users/arsenyp/.dev3.0/native-host-images/tag/dev3-terminal-host",
			startSignature: "501@t0",
		},
		shell: {
			pid: 502,
			command: ["/bin/zsh", "-lc", "claude --dangerously-skip-permissions 'rotate the prod secret'"],
			startSignature: "502@t0",
		},
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
	});

	it("carries no path, endpoint, port, or raw command line", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: secretRecord }, [501, 502]));
		const serialised = `${JSON.stringify(rows)}\n${renderNativeProcesses(rows)}`;
		for (const leak of ["/Users/", "arsenyp", "51234", "127.0.0.1", "claude", "secret", "-lc", "@t0"]) {
			expect(serialised).not.toContain(leak);
		}
	});

	it("keeps only the executable basename", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: secretRecord }, [501, 502]));
		expect(rows.map((r) => r.executable)).toEqual(["dev3-terminal-host", "zsh"]);
	});

	it("keeps a windows-style executable path to its basename too", () => {
		const rows = collectNativeProcesses(
			deps({
				[SESSION]: record({
					host: { pid: 501, executable: "C:\\Users\\me\\dev3-terminal-host.exe", startSignature: "" },
					shell: {
						pid: 502,
						command: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
						startSignature: "",
					},
				}),
			}),
		);
		expect(rows.map((r) => r.executable)).toEqual(["dev3-terminal-host.exe", "powershell.exe"]);
	});
});

describe("doctor --processes rendering", () => {
	it("says so plainly when there is nothing to list", () => {
		expect(renderNativeProcesses([])).toBe("No native terminal sessions on this machine.\n");
	});

	it("renders one aligned row per process under a stable header", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record() }, [501, 502]));
		const lines = renderNativeProcesses(rows).trimEnd().split("\n");
		expect(lines[0]).toMatch(/^\s*TASK\s+PANE\s+ROLE\s+PID\s+PARENT\s+EXECUTABLE\s+STATE$/);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("seq:1383");
		expect(lines[1]).toContain("host");
		expect(lines[2]).toContain("shell");
	});

	it("keeps the JSON keys stable, so scripts can rely on them", () => {
		const rows = collectNativeProcesses(deps({ [SESSION]: record() }, [501, 502]));
		expect(Object.keys(rows[0]!)).toEqual([
			"sessionId",
			"seq",
			"paneId",
			"role",
			"pid",
			"parentPid",
			"executable",
			"state",
		]);
	});
});
