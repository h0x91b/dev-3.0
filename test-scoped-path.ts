import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "./test-isolation";

/**
 * A fixture path no other test in the file can hold.
 *
 * Vitest records a timeout failure but does not stop the test body: the dead
 * test keeps executing, and a deferred timer inside it can rebind a *shared*
 * fixture path under its successor, killing that one with a real assertion
 * failure. Keying the path on the running test makes the collision structurally
 * impossible instead of relying on the zombie to behave.
 *
 * Call it once at the top of a test and keep the result in a local const — a
 * module-level variable would be re-read by the zombie's own closures and hand
 * it the successor's path again.
 *
 * A unix socket belongs in `testSocketPath` instead: the isolated run root this
 * builds on is too deep to fit the kernel's socket path limit.
 */
export function testScopedPath(name: string): string {
	if (name.endsWith(".sock")) {
		throw new Error(`Use testSocketPath("${name}") — the isolated run root does not fit a socket path`);
	}
	return join(testRoot("DEV3_TEST_ROOT"), scopeKey(name));
}

/**
 * The short directory this run owns for unix sockets, already created.
 *
 * Use it when a suite needs a socket DIRECTORY of its own (an `mkdtempSync`
 * base, or a fixture the code under test scans). For a single socket file,
 * `testSocketPath` gives the per-test keying as well.
 */
export function testSocketRoot(): string {
	const root = testRoot("DEV3_TEST_SOCKET_ROOT");
	mkdirSync(root, { recursive: true });
	return root;
}

/**
 * A socket path scoped to the running test, short enough to actually bind.
 *
 * The limit is the kernel's (`sun_path`, 104 bytes on macOS including the NUL),
 * and a path over it fails with a bare EINVAL that reads like a broken fixture
 * rather than a too-long name — which is why this asserts instead of trusting
 * the arithmetic to stay true on the next machine.
 */
export function testSocketPath(name: string): string {
	const path = join(testSocketRoot(), scopeKey(name));
	const bytes = Buffer.byteLength(path);
	if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(`Socket fixture path is too long to bind (${bytes} bytes): ${path}`);
	}
	return path;
}

function scopeKey(name: string): string {
	const testName = expect.getState().currentTestName ?? "unknown-test";
	return `${createHash("sha1").update(testName).digest("hex").slice(0, 8)}-${name}`;
}

function testRoot(variable: "DEV3_TEST_ROOT" | "DEV3_TEST_SOCKET_ROOT"): string {
	const root = process.env[variable];
	if (!root) throw new Error(`${variable} was not configured by the Vitest config`);
	return root;
}
