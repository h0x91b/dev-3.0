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
		copy: {
			"../../../dist/native/dev3-terminal-host.js": "native/dev3-terminal-host.js",
		},
		win: {
			bundleCEF: false,
		},
	},
	release: {
		baseUrl: "",
		generatePatch: false,
	},
	scripts: {
		postBuild: "../../verify-packaged-windows-conpty.ts",
	},
} satisfies ElectrobunConfig;
