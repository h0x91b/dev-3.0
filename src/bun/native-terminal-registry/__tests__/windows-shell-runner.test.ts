import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = readFileSync(fileURLToPath(new URL("./run-windows-shell-matrix.ps1", import.meta.url)), "utf8");
const ownedChildProbe = readFileSync(fileURLToPath(new URL("./windows-owned-child-probe.ts", import.meta.url)), "utf8");
const matrix = readFileSync(fileURLToPath(new URL("./windows-shell-matrix.ts", import.meta.url)), "utf8");

describe("native Windows shell matrix runner", () => {
	it("collapses duplicate PATH applications to one scalar executable path", () => {
		expect(runner).toContain("function Get-ApplicationPath");
		expect(runner).toContain("Select-Object -First 1 -ExpandProperty Source");
		expect(runner.match(/Get-Command /g)).toHaveLength(1);
		expect(runner).not.toMatch(/& \$[A-Za-z]+\.Source/);
	});

	it("uses the PowerShell 5.1 string overload when removing WSL NUL padding", () => {
		expect(runner).toContain('.Replace(([char]0).ToString(), [string]::Empty)');
	});

	it("resolves a PowerShell 7 execution alias to the physical process executable", () => {
		expect(runner).toContain("$pwshCommand = Get-ApplicationPath -Name \"pwsh.exe\"");
		expect(runner).toContain("(Get-Process -Id $PID).Path");
		expect(runner).toContain("Get-ApplicationDetection -Path $pwshPath");
	});

	it("detaches the owned descendant so it survives its short-lived launcher", () => {
		expect(ownedChildProbe).toContain("detached: true");
	});

	it("allows asynchronous Job Object teardown to remove every owned PID", () => {
		expect(matrix).toContain('"owned-boundary"');
		expect(matrix).toContain("isProcessInWindowsJob(token, pid)");
		expect(matrix).toContain("await waitForProcessesToExit(");
		expect(matrix).toContain("const ownedPids = [record.host.pid, record.shell.pid, ownedChildPid]");
		expect(matrix).toContain("stop left live PIDs after the teardown deadline");
	});
});
