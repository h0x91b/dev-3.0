/**
 * Print the per-machine dev web-access code (used by `bun run dev`).
 *
 * `dev3 remote` and the dev app's web UI authenticate browsers with a token. In
 * dev we want a STABLE token so the agent / `debug-ui` skill can reuse the URL
 * without scraping a rotating JWT — but baking a fixed UUID into source (as the
 * `dev` script used to) leaves one hardcoded secret in the repo forever.
 *
 * Instead we generate a random UUID ONCE per machine and persist it at
 * ~/.dev3.0/dev-web-access-code (0600), reusing it on every `bun run dev`. It is
 * dev-only (prod uses a rotating JWT) and an additive file in the data dir, so
 * it does not touch the frozen ~/.dev3.0 layout. Delete the file to rotate the
 * code. The `debug-ui` skill reads the same file.
 *
 * Output: the code on stdout with no trailing newline, so `$(...)` in the `dev`
 * script captures it cleanly as the DEV3_REMOTE_STATIC_CODE value.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// Mirror src/bun/paths.ts: DEV3_HOME = $HOME/.dev3.0 (HOME falls back to homedir()).
const home = process.env.HOME || homedir();
const dir = `${home}/.dev3.0`;
const file = `${dir}/dev-web-access-code`;

function readOrCreate(): string {
	try {
		const existing = readFileSync(file, "utf-8").trim();
		if (existing) return existing;
	} catch {
		// Missing or unreadable — fall through and create it.
	}
	const code = randomUUID();
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${code}\n`, { mode: 0o600 });
	return code;
}

process.stdout.write(readOrCreate());
