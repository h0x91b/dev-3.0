import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "dev-3.0",
		identifier: "dev3.electrobun.dev",
		version: "0.1.14",
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
