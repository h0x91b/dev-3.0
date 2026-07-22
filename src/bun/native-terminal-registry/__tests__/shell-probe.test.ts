import { describe, expect, it } from "vitest";
import { cmdArgvProbeBatch, powershellArgvProbeCommand } from "../shell-probe";

const args = ["argument with spaces", 'quote"value', "meta & | < > ^ ! % ( ) ;", "plain-tail"];

describe("Windows interactive shell argv probes", () => {
	it("uses one Windows-quoted argument line for PowerShell 5.1 and 7", () => {
		expect(
			powershellArgvProbeCommand(
				String.raw`C:\Program Files\Bun\bun.exe`,
				String.raw`D:\repo path\windows-shell-argv-probe.ts`,
				args,
			),
		).toBe(
			String.raw`$probe = Start-Process -FilePath 'C:\Program Files\Bun\bun.exe' -ArgumentList '"D:\repo path\windows-shell-argv-probe.ts" "argument with spaces" "quote\"value" "meta & | < > ^ ! % ( ) ;" "plain-tail"' -NoNewWindow -Wait -PassThru; if ($probe.ExitCode -ne 0) { throw "argv probe exited $($probe.ExitCode)" }`,
		);
	});

	it("keeps cmd quoting balanced around embedded quotes and metacharacters", () => {
		expect(cmdArgvProbeBatch(args)).toBe(
			String.raw`@echo off
setlocal DisableDelayedExpansion
"%DEV3_BUN_EXE%" "%DEV3_ARG_PROBE%" "argument with spaces" "quote"\^""value" "meta & | < > ^ ! %% ( ) ;" "plain-tail"
endlocal
`.replaceAll("\n", "\r\n"),
		);
	});
});
