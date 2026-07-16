import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configureTestIsolation } from "./test-isolation";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
configureTestIsolation("mainview", repoRoot);

export default defineConfig({
	plugins: [react()],
	test: {
		root: "src/mainview",
		environment: "happy-dom",
		globals: true,
		setupFiles: ["./test-setup.ts"],
		globalSetup: [fileURLToPath(new URL("./test-global-setup.ts", import.meta.url))],
	},
});
