import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "dev-3.0",
		identifier: "dev3.electrobun.dev",
		version: "1.0.0",
	},
	release: {
		baseUrl: "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0",
	},
	build: {
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: false,
			notarize: false,
			entitlements: {
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
			"changelog.json": "changelog.json",
			"dist/dev3": "cli/dev3",
			"src/assets/sounds": "sounds",
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
} satisfies ElectrobunConfig;
