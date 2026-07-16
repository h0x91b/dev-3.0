import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("cli", repoRoot);

export default defineConfig({
	test: {
		root: "src/cli",
		globals: true,
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
