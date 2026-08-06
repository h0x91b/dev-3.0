/**
 * Runs inside the Electrobun `postBuild` hook on Windows: put the app icon into
 * the packaged executables, then prove it is there.
 *
 * Electrobun already tried and failed — its CLI is a `bun --compile` standalone
 * with `require.resolve("rcedit/package.json")` frozen to the builder's own CI
 * path, and the failure is a `console.warn`. We own `rcedit` through our lockfile
 * instead, so nothing here depends on a binary being present on the machine.
 * See `decisions/214-vendor-rcedit-for-windows-icons.md`.
 *
 * Hard only where a human receives the result. `emitsUpdateArchive()` is the same
 * gate the update-archive proof uses: a plain local `bun run dev` must not die
 * over a cosmetic icon, so it prints one line naming the cause and the fix.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "../src/bun/spawn";
import { embedWindowsIcons } from "../src/bun/windows-icons/embed-windows-icons";
import { emitsUpdateArchive } from "../src/shared/electrobun-build-env";
import electrobunConfig from "../electrobun.config";

const require_ = createRequire(import.meta.url);
const buildEnvironment = process.env.ELECTROBUN_BUILD_ENV;
const required = emitsUpdateArchive(buildEnvironment);

function resolveRcedit(): string {
	const rceditDir = dirname(require_.resolve("rcedit/package.json"));
	const rcedit = join(rceditDir, "bin", "rcedit-x64.exe");
	if (!existsSync(rcedit)) {
		throw new Error(
			`rcedit is installed but ships no ${rcedit}. ` +
				"Cause: an incomplete or pruned node_modules. " +
				"Fix: run `bun install --frozen-lockfile`.",
		);
	}
	return rcedit;
}

async function toIcoFile(pngPath: string, buildDir: string): Promise<string> {
	if (pngPath.toLowerCase().endsWith(".ico")) return pngPath;
	const pngToIco = (await import("png-to-ico")).default;
	const icoPath = join(buildDir, "dev3-windows-icon.ico");
	writeFileSync(icoPath, new Uint8Array(await pngToIco(pngPath)));
	return icoPath;
}

async function run(): Promise<void> {
	const buildDir = process.env.ELECTROBUN_BUILD_DIR;
	const appName = process.env.ELECTROBUN_APP_NAME;
	if (!buildDir || !appName) {
		throw new Error(
			"ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME are unset. " +
				"Cause: this script ran outside electrobun's postBuild hook. " +
				"Fix: invoke it through `scripts.postBuild` in electrobun.config.ts.",
		);
	}

	const iconSource = electrobunConfig.build.win.icon;
	const icoPath = await toIcoFile(join(process.cwd(), iconSource), buildDir);

	const targets = embedWindowsIcons({
		bundleRoot: join(buildDir, appName),
		icoPath,
		rceditPath: resolveRcedit(),
		probe: { exists: existsSync, read: (path) => new Uint8Array(readFileSync(path)) },
		run: (rcedit, args) => {
			const result = spawnSync([rcedit, ...args], { stdio: ["ignore", "inherit", "inherit"] });
			if (result.exitCode !== 0) {
				throw new Error(
					`rcedit exited with code ${result.exitCode} for ${args[0]}. ` +
						"Cause: the icon could not be written into the executable. " +
						"Fix: read rcedit's output above; the icon file is " + icoPath,
				);
			}
		},
	});

	console.log(
		`[windows-icons] embedded and verified the app icon in ${targets.map((target) => target.relativePath).join(", ")}`,
	);
}

try {
	await run();
} catch (error) {
	if (required) throw error;
	console.warn(
		`[windows-icons] icon not embedded, continuing because the '${buildEnvironment}' build ships to nobody: ${error}`,
	);
}

export {};
