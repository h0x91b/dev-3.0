import type { ElectrobunConfig } from "electrobun";
import { MINIMUM_WINDOWS_CONPTY_BUN_VERSION } from "../../../src/shared/native-terminal-runtime";

export default {
	app: {
		name: "dev3-conpty-package-tracer",
		identifier: "dev3.electrobun.conpty-package-tracer",
		version: "1.0.0",
	},
	build: {
		bunVersion: MINIMUM_WINDOWS_CONPTY_BUN_VERSION,
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy:
			process.platform === "win32"
				? { "../../../dist/native/dev3-terminal-host.js": "native/dev3-terminal-host.js" }
				: {},
		win: {
			bundleCEF: false,
		},
	},
	release: {
		baseUrl: "",
		generatePatch: false,
	},
	scripts: {
		postPackage: "../../verify-windows-conpty-update-archive.ts",
	},
} satisfies ElectrobunConfig;
