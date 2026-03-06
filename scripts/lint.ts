/**
 * TypeScript lint wrapper.
 *
 * Runs `tsc --noEmit` and reports only errors originating from our `src/`
 * directory. Third-party packages (e.g. electrobun) ship raw `.ts` source
 * files instead of `.d.ts` declarations, so `skipLibCheck` does not suppress
 * their errors. We own only `src/` — errors there must be zero.
 */

// Ensure build-info.generated.ts exists (it's created during build,
// but in a fresh worktree it won't be there yet).
const buildInfoPath = `${import.meta.dir}/../src/shared/build-info.generated.ts`;
if (!(await Bun.file(buildInfoPath).exists())) {
	const gen = Bun.spawnSync(
		["bun", `${import.meta.dir}/generate-build-info.ts`],
		{ stdout: "inherit", stderr: "inherit", env: process.env },
	);
	if (gen.exitCode !== 0) {
		console.error("Failed to generate build-info.generated.ts");
		process.exit(1);
	}
}

const result = Bun.spawnSync(["bun", "x", "tsc", "--noEmit"], {
	stdout: "pipe",
	stderr: "pipe",
	env: process.env,
});

const combined = [result.stdout, result.stderr]
	.map((b) => (b ? Buffer.from(b as ArrayBuffer).toString() : ""))
	.join("");

const srcErrors = combined.split("\n").filter((l) => l.startsWith("src/"));

if (srcErrors.length > 0) {
	process.stderr.write(srcErrors.join("\n") + "\n");
	process.exit(1);
}

console.log("TypeScript: no errors in src/");
