import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VITE_DEV_PORT_ENV, viteDevPort } from "./src/shared/vite-dev-server";

export default defineConfig(({ command }) => {
	const port = viteDevPort(process.env);
	// The dev-channel window only probes the task's own port, so a dev server
	// anywhere else would be invisible — refuse to start one instead.
	if (command === "serve" && port === null) {
		throw new Error(`vite dev server needs a task-allocated port: ${VITE_DEV_PORT_ENV} is not set (run it inside a dev3 task with portCount >= 2)`);
	}
	return {
		plugins: [react()],
		root: "src/mainview",
		// envDir defaults to `root`, so without this a repo-root .env is silently
		// ignored — and that is where .env.example tells you to put it.
		envDir: "../..",
		define: {
			"globalThis.__DEV3_BROWSER_RPC_PORT": JSON.stringify(19191),
		},
		build: {
			outDir: "../../dist",
			emptyOutDir: true,
		},
		server: {
			port: port ?? undefined,
			strictPort: true,
		},
	};
});
