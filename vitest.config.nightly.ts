import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		root: "src/bun",
		globals: true,
		include: ["__tests__/nightly/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
