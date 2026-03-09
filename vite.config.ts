import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
	plugins: [react()],
	root: "src/mainview",
	define: {
		"globalThis.__DEV3_BROWSER_RPC_PORT": JSON.stringify(19191),
	},
	resolve: {
		alias: command === "serve"
			? {
				// In dev mode (Vite HMR / Chrome), replace electrobun/view with a
				// no-op stub. The real module is only used inside Electrobun's WKWebView.
				"electrobun/view": resolve(__dirname, "src/mainview/electrobun-stub.ts"),
			}
			: {},
	},
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
}));
