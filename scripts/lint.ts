/**
 * TypeScript lint wrapper.
 *
 * Runs `tsc --noEmit` and reports only errors originating from our `src/`
 * directory. Third-party packages (e.g. electrobun) ship raw `.ts` source
 * files instead of `.d.ts` declarations, so `skipLibCheck` does not suppress
 * their errors. We own only `src/` — errors there must be zero.
 */

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
