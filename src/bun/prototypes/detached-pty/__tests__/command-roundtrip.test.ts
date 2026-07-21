import { describe, expect, it } from "vitest";
import { powerShellReattachStateProbe, powerShellRootStateProbe, sendUntilObserved } from "./command-roundtrip";

describe("detached-pty command round trips", () => {
	it("uses unambiguous delimiters around a scoped PowerShell environment variable", () => {
		const probe = powerShellReattachStateProbe("state-100-200", 200);

		expect(probe.command).toBe('Write-Output "MARKER[$env:PROTO_STATE][$PID]"');
		expect(probe.observe("MARKER:200")).toBeNull();
		expect(probe.observe("MARKER[state-100-200][200]")).toBe("MARKER[state-100-200][200]");
	});

	it("rejects a root acknowledgement when startup swallowed the state assignment", () => {
		const probe = powerShellRootStateProbe("state-100-200", 200);

		expect(probe.observe("ROOTSTATE[][200]")).toBeNull();
		expect(probe.observe("ROOTSTATE[state-100-200][200]")).toBe("ROOTSTATE[state-100-200][200]");
	});

	it("does not repeat a command once its output is observed", async () => {
		let sends = 0;
		const observed = await sendUntilObserved({
			send: () => sends++,
			observe: () => "ready",
			attempts: 3,
			attemptTimeoutMs: 1,
			pollIntervalMs: 0,
		});

		expect(observed).toBe("ready");
		expect(sends).toBe(1);
	});

	it("retries when an interactive shell drops the first command during startup", async () => {
		let sends = 0;
		let output = "";

		const observed = await sendUntilObserved({
			send() {
				sends++;
				if (sends > 1) output = "READY[4242]";
			},
			observe: () => /READY\[(\d+)\]/.exec(output),
			attempts: 3,
			attemptTimeoutMs: 1,
			pollIntervalMs: 0,
		});

		expect(observed?.[1]).toBe("4242");
		expect(sends).toBe(2);
	});

	it("stops after the configured number of attempts", async () => {
		let sends = 0;
		const observed = await sendUntilObserved({
			send: () => sends++,
			observe: () => null,
			attempts: 3,
			attemptTimeoutMs: 1,
			pollIntervalMs: 0,
		});

		expect(observed).toBeNull();
		expect(sends).toBe(3);
	});
});
