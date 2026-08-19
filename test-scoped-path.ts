import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";

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
 */
export function testScopedPath(name: string): string {
	const root = process.env.DEV3_TEST_ROOT;
	if (!root) throw new Error("DEV3_TEST_ROOT was not configured by the Vitest config");
	const testName = expect.getState().currentTestName ?? "unknown-test";
	const key = createHash("sha1").update(testName).digest("hex").slice(0, 8);
	const path = join(root, `${key}-${name}`);
	// A unix socket path over ~104 bytes fails to bind with a bare EINVAL that
	// reads like a broken fixture. The isolated run root already eats ~82.
	if (name.endsWith(".sock") && path.length > 100) {
		throw new Error(`Socket fixture path is too long to bind (${path.length} bytes): ${path}`);
	}
	return path;
}
