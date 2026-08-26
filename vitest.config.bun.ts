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
		root: "src/bun",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
