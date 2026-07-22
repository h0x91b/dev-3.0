import { describe, expect, it } from "vitest";
import { cmdArgvProbeBatch, powershellArgvProbeCommand } from "../shell-probe";

const args = ["argument with spaces", 'quote"value', "meta & | < > ^ ! % ( ) ;", "plain-tail"];

describe("Windows interactive shell argv probes", () => {
	it("quotes PowerShell arguments as literal values", () => {
		expect(powershellArgvProbeCommand(args)).toBe(
			`& $env:DEV3_BUN_EXE $env:DEV3_ARG_PROBE 'argument with spaces' 'quote"value' 'meta & | < > ^ ! % ( ) ;' 'plain-tail'`,
		);
	});

	it("quotes cmd batch arguments for cmd parsing followed by Windows argv parsing", () => {
		expect(cmdArgvProbeBatch(args)).toBe(
			'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%DEV3_BUN_EXE%" "%DEV3_ARG_PROBE%" "argument with spaces" "quote\\"value" "meta & | < > ^ ! %% ( ) ;" "plain-tail"\r\nendlocal\r\n',
		);
	});
});
