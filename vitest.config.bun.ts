import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";
import { ciRetry } from "./test-retry";
import { resolveMaxWorkers } from "./test-workers";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("bun", repoRoot);

export default defineConfig({
	test: {
		retry: ciRetry,
		maxWorkers: resolveMaxWorkers("bun"),
		// See decisions/2026/11/25/renderer-tests-on-vm-threads.md; test-realm-guard.ts restores per file.
		pool: "vmForks",
		root: "src/bun",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
