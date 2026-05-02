import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ParsedArgs } from "../args";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError } from "../output";
import {
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_GUI_DEPS_MISSING,
	CLI_EXIT_CODE_USAGE_ERROR,
} from "../../shared/cli-exit-codes";

const DEFAULT_BUNDLE_URL =
	"https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0/stable-linux-x64-dev-3.0.tar.zst";

function buildGuiHelp(): string {
	const url = process.env.DEV3_GUI_BUNDLE_URL || DEFAULT_BUNDLE_URL;
	return `dev3 gui — launch the dev-3.0 desktop app.

Usage:
  dev3 gui

What it does:
  macOS — opens the installed dev-3.0 app from /Applications (or
          ~/Applications) via \`open -a\`. If the app isn't installed,
          prints how to install it via Homebrew Cask.

  Linux — runs the Electrobun launcher from ~/.dev3.0/gui/dev-3.0/.
          On the first run the bundle is downloaded from S3 (~88 MB),
          extracted, and registered as an XDG desktop entry. The CLI then
          probes runtime libraries (libwebkit2gtk-4.1, libgtk-3, libcairo2,
          libayatana-appindicator3, librsvg2). If any are missing, it prints
          the install command for your distro (apt/dnf/pacman) and exits.
          No sudo is invoked from this CLI — the user runs the printed command.

  After the first install the launcher self-updates via Electrobun's built-in
  patcher; \`dev3 gui\` does NOT re-download on each invocation.

Flags:
  --help, -h    Show this help.

Environment:
  DEV3_GUI_BUNDLE_URL   Override the S3 bundle URL (Linux first install only).
                        Defaults to:
                          ${url}
  DEV3_GUI_BUNDLE_PATH  Override the install location of the Linux bundle.
                        Defaults to ~/.dev3.0/gui/dev-3.0
`;
}

interface DistroInstall {
	id: string;
	command: string;
	packages: readonly string[];
}

const DISTRO_INSTALL_COMMANDS: readonly DistroInstall[] = [
	{
		id: "ubuntu",
		command: "sudo apt install -y",
		packages: [
			"libwebkit2gtk-4.1-0",
			"libgtk-3-0",
			"libcairo2",
			"libayatana-appindicator3-1",
			"librsvg2-2",
		],
	},
	{
		id: "debian",
		command: "sudo apt install -y",
		packages: [
			"libwebkit2gtk-4.1-0",
			"libgtk-3-0",
			"libcairo2",
			"libayatana-appindicator3-1",
			"librsvg2-2",
		],
	},
	{
		id: "fedora",
		command: "sudo dnf install -y",
		packages: [
			"webkit2gtk4.1",
			"gtk3",
			"cairo",
			"libayatana-appindicator-gtk3",
			"librsvg2",
		],
	},
	{
		id: "arch",
		command: "sudo pacman -S --needed",
		packages: [
			"webkit2gtk-4.1",
			"gtk3",
			"cairo",
			"libayatana-appindicator",
			"librsvg",
		],
	},
	{
		id: "manjaro",
		command: "sudo pacman -S --needed",
		packages: [
			"webkit2gtk-4.1",
			"gtk3",
			"cairo",
			"libayatana-appindicator",
			"librsvg",
		],
	},
];

function guiBundleUrl(): string {
	return process.env.DEV3_GUI_BUNDLE_URL || DEFAULT_BUNDLE_URL;
}

function guiBundleRoot(): string {
	const home = process.env.HOME || "/tmp";
	return process.env.DEV3_GUI_BUNDLE_PATH || `${home}/.dev3.0/gui/dev-3.0`;
}

export async function handleGui(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
	if (args.flags.help === "true" || args.flags.h === "true") {
		process.stdout.write(buildGuiHelp());
		return;
	}

	if (subcommand !== undefined) {
		exitError(`"dev3 gui" takes no subcommand (got "${subcommand}").`, undefined, CLI_EXIT_CODE_USAGE_ERROR);
	}
	if (args.positional.length > 0) {
		exitError(`Unknown positional argument: "${args.positional[0]}"`, undefined, CLI_EXIT_CODE_USAGE_ERROR);
	}
	rejectUnknownFlags(args, ["help", "h"]);

	const platform = process.platform;
	if (platform === "darwin") {
		launchMacApp();
		return;
	}
	if (platform === "linux") {
		await launchLinuxApp();
		return;
	}
	exitError(
		`dev3 gui is not supported on ${platform} yet`,
		"Only macOS and Linux are supported. Windows is on the roadmap.",
	);
}

// ── macOS ──────────────────────────────────────────────────────────────────

function findMacApp(): string | null {
	const home = process.env.HOME || "";
	const candidates = [
		"/Applications/dev-3.0.app",
		home && `${home}/Applications/dev-3.0.app`,
	].filter(Boolean) as string[];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}
	return null;
}

function launchMacApp(): void {
	const appPath = findMacApp();
	if (!appPath) {
		exitError(
			"dev-3.0 desktop app not found",
			[
				"Looked in /Applications and ~/Applications.",
				"",
				"Install the desktop app via Homebrew Cask:",
				"  brew install --cask dev3",
				"",
				"Or download a DMG from:",
				"  https://github.com/h0x91b/dev-3.0/releases",
			].join("\n"),
		);
	}
	// `open -a <abs-path>` launches the app. We don't use --wait-apps because the
	// CLI should exit as soon as the app is launching; the GUI runs independently.
	const child = spawnSync("open", ["-a", appPath], { stdio: "inherit" });
	if (child.status !== 0) {
		exitError(`open failed for ${appPath}`, undefined, CLI_EXIT_CODE_COMMAND_FAILED);
	}
}

// ── Linux ──────────────────────────────────────────────────────────────────

async function launchLinuxApp(): Promise<void> {
	const bundleRoot = guiBundleRoot();
	const launcher = resolve(bundleRoot, "bin", "launcher");

	if (!existsSync(launcher)) {
		await installLinuxBundle(bundleRoot);
	}

	const missing = probeMissingLibs(bundleRoot);
	if (missing.length > 0) {
		printMissingDepsMessage(missing);
		process.exit(CLI_EXIT_CODE_GUI_DEPS_MISSING);
	}

	// Spawn the launcher; forward stdio and signals so Ctrl-C cleanly stops it.
	const child = spawn(launcher, [], { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function installLinuxBundle(bundleRoot: string): Promise<void> {
	requireExecutable("tar", "Install via your package manager (e.g., apt install tar).");
	requireExecutable(
		"zstd",
		"Install via your package manager (e.g., apt install zstd, dnf install zstd, pacman -S zstd).",
	);

	const home = process.env.HOME || "/tmp";
	const guiHome = `${home}/.dev3.0/gui`;
	mkdirSync(guiHome, { recursive: true });

	const tarballPath = `${guiHome}/dev3-gui.tar.zst`;
	const url = guiBundleUrl();

	process.stdout.write(`Downloading dev-3.0 GUI bundle from ${url}\n`);
	await downloadToFile(url, tarballPath);

	process.stdout.write(`Extracting to ${guiHome}\n`);
	const extract = spawnSync("tar", ["-I", "zstd", "-xf", tarballPath, "-C", guiHome], {
		stdio: "inherit",
	});
	if (extract.status !== 0) {
		exitError(
			"failed to extract dev-3.0 GUI bundle",
			`tar exited with status ${extract.status}. The downloaded archive at ${tarballPath} was kept for inspection.`,
		);
	}

	try { unlinkSync(tarballPath); } catch { /* tarball may already be gone — non-fatal */ }

	const launcher = resolve(bundleRoot, "bin", "launcher");
	if (!existsSync(launcher)) {
		exitError(
			"dev-3.0 GUI bundle layout unexpected after extract",
			`Expected ${launcher} but it does not exist. The archive may have been published with an incompatible layout.`,
		);
	}
	try { chmodSync(launcher, 0o755); } catch { /* permissions may already be correct */ }

	registerXdgDesktopEntry(bundleRoot);
	process.stdout.write(`Installed at ${bundleRoot}\n`);
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(url);
	} catch (err) {
		exitError(
			`failed to download dev-3.0 GUI bundle`,
			`URL: ${url}\n${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!response.ok) {
		exitError(
			`failed to download dev-3.0 GUI bundle`,
			`URL: ${url}\nHTTP ${response.status} ${response.statusText}`,
		);
	}
	if (!response.body) {
		exitError("download returned no body", `URL: ${url}`);
	}

	// `Bun.write` accepts a Response directly and streams the body to disk.
	// We use the typed-array fallback so this also works when running the CLI
	// under Node (in unit tests). Bun runtime is the prod target; either works.
	const buf = new Uint8Array(await response.arrayBuffer());
	writeFileSync(destPath, buf);
}

function registerXdgDesktopEntry(bundleRoot: string): void {
	const home = process.env.HOME;
	if (!home) return;

	const launcher = resolve(bundleRoot, "bin", "launcher");
	const iconPath = resolve(bundleRoot, "Resources", "AppIcon.png");
	const desktopBody = [
		"[Desktop Entry]",
		"Version=1.0",
		"Type=Application",
		"Name=dev-3.0",
		"Comment=Terminal-centric project manager for AI coding agents",
		`Exec=${launcher}`,
		existsSync(iconPath) ? `Icon=${iconPath}` : "Icon=dev-3.0",
		"Terminal=false",
		"StartupWMClass=dev-3.0",
		"Categories=Utility;Development;",
		"",
	].join("\n");

	const xdgDir = `${home}/.local/share/applications`;
	try {
		mkdirSync(xdgDir, { recursive: true });
		writeFileSync(`${xdgDir}/dev-3.0.desktop`, desktopBody);
	} catch (err) {
		// Non-fatal — the GUI still works, the user just doesn't get a menu entry.
		process.stderr.write(
			`warning: could not register XDG desktop entry: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

// ── Linux runtime-deps probe ──────────────────────────────────────────────

function probeMissingLibs(bundleRoot: string): string[] {
	const target = resolve(bundleRoot, "bin", "libNativeWrapper.so");
	if (!existsSync(target)) return [];

	// Run ldd with the bundle's bin/ on LD_LIBRARY_PATH so it finds sibling
	// libs (libasar.so etc.) that ship inside the bundle. The Electrobun
	// launcher does this implicitly at exec time; without it our probe would
	// report bundled libs as "not found" and we'd print a misleading distro
	// install command for libs that are actually right there in the tarball.
	const result = spawnSync("ldd", [target], {
		encoding: "utf-8",
		env: {
			...process.env,
			LD_LIBRARY_PATH: `${resolve(bundleRoot, "bin")}:${process.env.LD_LIBRARY_PATH ?? ""}`,
		},
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		// `ldd` not installed or refused — we can't probe. Don't block the user;
		// let the launcher try and produce its own error.
		return [];
	}

	const missing: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = line.match(/^\s*(\S+)\s*=>\s*not found/);
		if (match) missing.push(match[1]);
	}
	return missing;
}

function detectDistro(): DistroInstall | null {
	let osRelease = "";
	try {
		osRelease = readFileSync("/etc/os-release", "utf-8");
	} catch {
		return null;
	}

	const idLine = osRelease.split("\n").find((l) => l.startsWith("ID="));
	const idLikeLine = osRelease.split("\n").find((l) => l.startsWith("ID_LIKE="));
	const ids: string[] = [];
	if (idLine) ids.push(stripQuotes(idLine.slice(3)));
	if (idLikeLine) ids.push(...stripQuotes(idLikeLine.slice(8)).split(/\s+/));

	for (const id of ids) {
		const match = DISTRO_INSTALL_COMMANDS.find((d) => d.id === id);
		if (match) return match;
	}
	return null;
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function printMissingDepsMessage(missing: string[]): void {
	process.stderr.write(
		`error: dev-3.0 GUI cannot launch — system libraries are missing\n`,
	);
	process.stderr.write("  The desktop bundle is installed, but it depends on libraries that\n");
	process.stderr.write("  must be provided by your distro (we don't bundle GTK/WebKit):\n\n");
	for (const lib of missing) {
		process.stderr.write(`    ${lib}\n`);
	}

	const distro = detectDistro();
	process.stderr.write("\n");
	if (distro) {
		process.stderr.write(`  Run this command to install them (${distro.id}):\n`);
		process.stderr.write(`    ${distro.command} ${distro.packages.join(" ")}\n`);
	} else {
		process.stderr.write("  Install equivalents of:\n");
		process.stderr.write("    libwebkit2gtk-4.1, gtk3, cairo, libayatana-appindicator, librsvg2\n");
		process.stderr.write("  …from your distro's package manager.\n");
	}
	process.stderr.write("\n  Then rerun: dev3 gui\n");
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireExecutable(bin: string, hint: string): void {
	const r = spawnSync("which", [bin], { encoding: "utf-8" });
	if (r.status === 0 && typeof r.stdout === "string" && r.stdout.trim().length > 0) return;
	exitError(`${bin} not found on PATH — required to install the GUI bundle`, hint);
}
