import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = readFileSync(fileURLToPath(new URL("./run-windows-shell-matrix.ps1", import.meta.url)), "utf8");
const ownedChildProbe = readFileSync(fileURLToPath(new URL("./windows-owned-child-probe.ts", import.meta.url)), "utf8");
const matrix = readFileSync(fileURLToPath(new URL("./windows-shell-matrix.ts", import.meta.url)), "utf8");

describe("native Windows shell matrix runner", () => {
	it("resolves applications to one scalar path, strips WSL NUL padding on PowerShell 5.1, and selects a containable PowerShell 7 without falling through an explicit request", () => {
		expect(runner).toContain("function Get-ApplicationPath");
		expect(runner).toContain("Select-Object -First 1 -ExpandProperty Source");
		expect(runner.match(/Get-Command /g)).toHaveLength(1);
		expect(runner).not.toMatch(/& \$[A-Za-z]+\.Source/);

		{
			// Uses the PowerShell 5.1 string overload when removing WSL NUL padding.
			expect(runner).toContain('.Replace(([char]0).ToString(), [string]::Empty)');
		}

		{
			// Selects a containable PowerShell 7 executable without falling through an explicit request.
			expect(runner).toContain('[string]$PwshPath = ""');
			expect(runner).toContain("function Get-PowerShell7Selection");
			expect(runner).toContain('Join-Path $env:ProgramFiles "PowerShell\\7\\pwsh.exe"');
			expect(runner).toContain('$pathCommand = Get-ApplicationPath -Name "pwsh.exe"');
			expect(runner).toContain("function Test-IsWindowsAppsPath");
			expect(runner).toContain("Store/MSIX executables cannot satisfy native Job Object containment");
			expect(runner).toContain("Get-PowerShell7Selection -RequestedPath $PwshPath");
			expect(runner).toContain("-MissingReason $pwshSelection.reason");

			const selection = runner.slice(
				runner.indexOf("function Get-PowerShell7Selection"),
				runner.indexOf("$bunPath = Get-ApplicationPath"),
			);
			expect(selection.indexOf("if ($RequestedPath)")).toBeLessThan(selection.indexOf("$msiPath ="));
			expect(selection).toContain('return [ordered]@{ path = $resolved; reason = "" }');
			expect(runner).not.toContain("(Get-Process -Id $PID).Path");
		}
	});

	it("detaches the owned descendant and lets asynchronous Job Object teardown remove every owned PID", () => {
		expect(ownedChildProbe).toContain("detached: true");

		{
			// Allows asynchronous Job Object teardown to remove every owned PID.
			expect(matrix).toContain('"owned-boundary"');
			expect(matrix).toContain("isProcessInWindowsJob(token, pid)");
			expect(matrix).toContain("await waitForProcessesToExit(");
			expect(matrix).toContain("const ownedPids = [record.host.pid, record.shell.pid, ownedChildPid]");
			expect(matrix).toContain("stop left live PIDs after the teardown deadline");
		}
	});
});
