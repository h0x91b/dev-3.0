import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "dev-3.0",
		identifier: "dev3.electrobun.dev",
		version: "0.1.5",
	},
	release: {
		baseUrl: "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0",
		generatePatch: false,
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
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
