import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		root: "src/bun",
		globals: true,
		setupFiles: ["./test-setup.ts"],
	},
});
