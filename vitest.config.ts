import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";
import { ciRetry } from "./test-retry";
import { resolveMaxWorkers } from "./test-workers";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("mainview", repoRoot);

export default defineConfig({
	plugins: [react()],
	test: {
		retry: ciRetry,
		maxWorkers: resolveMaxWorkers("mainview"),
		root: "src/mainview",
		environment: "happy-dom",
		// One happy-dom window per worker instead of one per file: about half the CPU.
		// test-realm-guard.ts restores what a file patched. decisions/2026/11/25/renderer-tests-on-vm-threads.md
		pool: "vmThreads",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
