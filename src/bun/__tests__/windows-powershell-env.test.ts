import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPowerShell7ModuleDir, withoutPowerShell7ModulePaths } from "../../../scripts/windows-powershell-env";

const REPO = resolve(__dirname, "../../..");

// Verbatim from a pwsh 7.6.10 step on windows-latest image 20261116.315.1 (probe run 44876356092).
const RUNNER_PSMODULEPATH = [
	"C:\\Users\\runneradmin\\Documents\\PowerShell\\Modules",
	"C:\\Program Files\\PowerShell\\Modules",
	"c:\\program files\\powershell\\7\\Modules",
	"C:\\\\Modules\\az_15.6.1",
	"C:\\Users\\packer\\Documents\\WindowsPowerShell\\Modules",
	"C:\\Program Files\\WindowsPowerShell\\Modules",
	"C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
	"C:\\Program Files\\Microsoft SQL Server\\130\\Tools\\PowerShell\\Modules\\",
].join(";");

const pwshAt = (...homes: string[]) => (path: string) =>
	homes.some((home) => path.toLowerCase() === `${home}\\pwsh.exe`.toLowerCase());

describe("withoutPowerShell7ModulePaths", () => {
	it("drops exactly PowerShell 7's three dirs from the runner's real value", () => {
		const { env, dropped } = withoutPowerShell7ModulePaths(
			{ PSModulePath: RUNNER_PSMODULEPATH },
			"win32",
			pwshAt("c:\\program files\\powershell\\7"),
		);
		expect(dropped).toEqual([
			"C:\\Users\\runneradmin\\Documents\\PowerShell\\Modules",
			"C:\\Program Files\\PowerShell\\Modules",
			"c:\\program files\\powershell\\7\\Modules",
		]);
		expect(env.PSModulePath?.split(";")).toEqual([
			"C:\\\\Modules\\az_15.6.1",
			"C:\\Users\\packer\\Documents\\WindowsPowerShell\\Modules",
			"C:\\Program Files\\WindowsPowerShell\\Modules",
			"C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
			"C:\\Program Files\\Microsoft SQL Server\\130\\Tools\\PowerShell\\Modules\\",
		]);
	});

	it("is a no-op off Windows, where electrobun never calls PowerShell, and returns the same object when there is nothing to drop", () => {
		const input = { PSModulePath: RUNNER_PSMODULEPATH };
		expect(withoutPowerShell7ModulePaths(input, "darwin", () => true)).toEqual({ env: input, dropped: [] });
		const winOnly = { PSModulePath: "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules" };
		expect(withoutPowerShell7ModulePaths(winOnly, "win32", () => false).env).toBe(winOnly);
		const empty = { PATH: "x" };
		expect(withoutPowerShell7ModulePaths(empty, "win32", () => false).env).toBe(empty);
	});

	it("keeps the key's own spelling, since Windows env names ignore case", () => {
		const { env } = withoutPowerShell7ModulePaths(
			{ PSMODULEPATH: "C:\\Program Files\\PowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules" },
			"win32",
			() => false,
		);
		expect(env).toEqual({ PSMODULEPATH: "C:\\Program Files\\WindowsPowerShell\\Modules" });
	});
});

describe("isPowerShell7ModuleDir", () => {
	it("finds $PSHOME\\Modules by the pwsh.exe beside it and the redirected per-user dir, never a 5.1 dir", () => {
		const scoop = "C:\\Users\\me\\scoop\\apps\\pwsh\\current";
		expect(isPowerShell7ModuleDir(`${scoop}\\Modules`, pwshAt(scoop))).toBe(true);
		expect(isPowerShell7ModuleDir(`${scoop}\\Modules`, () => false)).toBe(false);
		for (const dir of [
			"C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
			"C:\\Program Files\\WindowsPowerShell\\Modules",
			"C:\\Users\\me\\OneDrive\\Documents\\WindowsPowerShell\\Modules",
		]) {
			expect(isPowerShell7ModuleDir(dir, () => false), dir).toBe(false);
		}
		// The per-user dir under a redirected Documents folder.
		expect(isPowerShell7ModuleDir("C:\\Users\\me\\OneDrive\\Documents\\PowerShell\\Modules", () => false)).toBe(true);
	});
});

// A bare `electrobun build` re-opens the hole: on windows-latest it fails to unpack its Bun.
describe("every electrobun CLI run goes through scripts/electrobun.ts", () => {
	const bareCall = /\bbunx\s+electrobun\b|electrobun\.cjs\b|(^|[\s&;|"'])electrobun\s+(build|dev)\b/;

	const lines = (path: string) =>
		readFileSync(path, "utf-8")
			.split("\n")
			.map((text, i) => ({ where: `${path.slice(REPO.length + 1)}:${i + 1}`, text }))
			.filter(({ text }) => !text.trim().startsWith("#") && bareCall.test(text));

	it("in package.json scripts", () => {
		const scripts = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")).scripts as Record<string, string>;
		const offenders = Object.entries(scripts).filter(([, command]) => bareCall.test(command));
		expect(offenders).toEqual([]);
	});

	it("in GitHub workflows", () => {
		const dir = join(REPO, ".github", "workflows");
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".yml"))
			.flatMap((name) => lines(join(dir, name)));
		expect(offenders).toEqual([]);
	});

	it("in the dev loop, which runs electrobun directly but strips the env first", () => {
		const dev = readFileSync(join(REPO, "scripts", "dev.ts"), "utf-8");
		expect(dev).toMatch(/stripPowerShell7ModulePathsInPlace\("dev"\)/);
	});
});
