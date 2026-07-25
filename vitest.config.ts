import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";
import { ciRetry } from "./test-retry";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("mainview", repoRoot);

export default defineConfig({
	plugins: [react()],
	test: {
		retry: ciRetry,
		root: "src/mainview",
		environment: "happy-dom",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
