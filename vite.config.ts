import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	root: "src/mainview",
	define: {
		"globalThis.__DEV3_BROWSER_RPC_PORT": JSON.stringify(19191),
	},
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
