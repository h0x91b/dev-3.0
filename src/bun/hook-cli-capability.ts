/**
 * Does the CLI that agent hooks actually run know a given socket method?
 *
 * Hooks call the shared `~/.dev3.0/bin/dev3`, which is not always this build's:
 * a `bun run dev` build never writes it (`managed-cli-guard.ts`), and with two
 * installed versions the last one started owns it. A feature that waits for a
 * hook's report must not switch on when that CLI cannot send it. The compiled
 * CLI carries its method names as plain strings, so one scan answers; it is
 * cached on the file's mtime and size.
 */
import { readFile, stat } from "node:fs/promises";
import { POSIX_DEV3_CLI, resolveDev3CliPath } from "../shared/dev3-cli-path";
import { resolveUserHome } from "../shared/user-home";
import { createLogger } from "./logger";

const log = createLogger("hook-cli-capability");

/**
 * The CLI file the generated hooks invoke. On POSIX that is the frozen
 * `~/.dev3.0/bin/dev3` string, tilde and all, so `$DEV3_HOME` never moves it.
 */
export function hookCliFilePath(): string {
	return process.platform === "win32" ? resolveDev3CliPath() : POSIX_DEV3_CLI.replace(/^~/, resolveUserHome());
}

const cache = new Map<string, { mtimeMs: number; size: number; methods: Map<string, boolean> }>();

export async function hookCliSupports(method: string, cliPath = hookCliFilePath()): Promise<boolean> {
	try {
		const { mtimeMs, size } = await stat(cliPath);
		let entry = cache.get(cliPath);
		if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
			entry = { mtimeMs, size, methods: new Map() };
			cache.set(cliPath, entry);
		}
		const known = entry.methods.get(method);
		if (known !== undefined) return known;
		const found = (await readFile(cliPath)).includes(method);
		entry.methods.set(method, found);
		if (!found) log.warn("The hook CLI predates a method this build relies on", { cliPath, method });
		return found;
	} catch (err) {
		log.warn("Cannot inspect the hook CLI", { cliPath, error: String(err) });
		return false;
	}
}

export function resetHookCliCapabilityCacheForTests(): void {
	cache.clear();
}
