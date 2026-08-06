import type { ElectrobunConfig } from "electrobun";
import { MINIMUM_WINDOWS_CONPTY_BUN_VERSION } from "./src/shared/native-terminal-runtime";

/** Windows refuses to execute an extensionless binary, so the packaged CLI keeps `.exe`. */
export function cliBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "dev3.exe" : "dev3";
}

/** `copy` is a flat map with no per-platform section, so the entry is picked here. */
export function cliCopyEntry(platform: NodeJS.Platform = process.platform): [string, string] {
	const name = cliBinaryName(platform);
	return [`dist/${name}`, `cli/${name}`];
}

const [cliCopySource, cliCopyDestination] = cliCopyEntry();

export default {
	app: {
		name: "dev-3.0",
		identifier: "dev3.electrobun.dev",
		version: "1.42.0",
		// Inbound deep links: `dev3://task/<id>`, `dev3://project/<id>`,
		// `dev3://new-task?project=<id>&text=<…>`. Electrobun writes CFBundleURLTypes
		// into Info.plist; macOS only registers it when the app lives in
		// /Applications. Handled in src/bun/index.ts (open-url). See decisions/2026/08/04/dev3-url-scheme-deep-links.md.
		urlSchemes: ["dev3"],
	},
	runtime: {
		// Standard macOS behavior: closing the last window does NOT quit the app —
		// it stays alive in the dock and is reopened via the `reopen` event.
		// Quitting goes through the `before-quit` gate (Cmd+Q / menu / dock Quit);
		// if no window is open at that point we reopen one to host the React quit
		// confirmation dialog.
		exitOnLastWindowClosed: false,
	},
	release: {
		baseUrl: "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0",
	},
	build: {
		// This is global across Electrobun platforms; decision 150 records why.
		bunVersion: MINIMUM_WINDOWS_CONPTY_BUN_VERSION,
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: false,
			notarize: false,
			entitlements: {
				"com.apple.security.device.audio-input":
					"Required for voice dictation in AI coding assistants",
				"com.apple.security.files.desktop.read-write":
					"dev-3.0 manages git worktrees and terminals for projects on your Desktop.",
				"com.apple.security.files.downloads.read-write":
					"dev-3.0 resolves file paths when you drag and drop files into the app.",
				"com.apple.security.files.user-selected.read-write":
					"dev-3.0 accesses project folders you choose to manage tasks and worktrees.",
			},
		},
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// index.html links these at the views root. They were never copied, so
			// every launch failed three resource loads — silent on macOS, loud in the
			// Windows console.
			"dist/favicon.png": "views/mainview/favicon.png",
			"dist/favicon-32.png": "views/mainview/favicon-32.png",
			"dist/favicon-16.png": "views/mainview/favicon-16.png",
			"dist/apple-touch-icon.png": "views/mainview/apple-touch-icon.png",
			"changelog.json": "changelog.json",
			[cliCopySource]: cliCopyDestination,
			"src/assets/sounds": "sounds",
			"src/assets/artifact-template": "artifact-template",
			// macOS notification-click shim (empty dir on Linux) — see decisions/2026/07/05/native-notification-click-shim.md.
			"dist/native": "native",
			// Bundled self-contained tmux + license notices (empty dir on Linux and
			// on dev machines without a local tmux build) — see decisions/2026/07/16/bundle-tmux-macos.md.
			"dist/tmux": "tmux",
		},
		linux: {
			bundleCEF: false,
			icon: "icon.iconset/icon_256x256.png",
		},
		win: {
			bundleCEF: false,
			icon: "icon.iconset/icon_256x256.png",
		},
	},
	scripts: {
		// preBuild clears the build folder before electrobun's own un-forced,
		// un-retried rmSync of it, which throws EBUSY on Windows. No-op elsewhere.
		preBuild: "./scripts/free-build-folder.ts",
		// postBuild assembles the versioned native host image into the bundle on
		// every platform, so it ships inside the update archive; postPackage
		// re-verifies the Windows image from the FINAL archive (no-op elsewhere).
		postBuild: "./scripts/package-native-host.ts",
		postPackage: "./scripts/verify-windows-conpty-update-archive.ts",
	},
} satisfies ElectrobunConfig;
