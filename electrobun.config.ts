import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "dev-3.0",
		identifier: "dev3.electrobun.dev",
		version: "0.3.7",
	},
	release: {
		baseUrl: "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"changelog.json": "changelog.json",
			"dist/dev3": "cli/dev3",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: false,
			notarize: false,
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
