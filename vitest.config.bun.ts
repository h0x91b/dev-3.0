import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";
import { ciRetry } from "./test-retry";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("bun", repoRoot);

export default defineConfig({
	test: {
		retry: ciRetry,
		root: "src/bun",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
