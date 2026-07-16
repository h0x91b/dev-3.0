import { cleanupTestIsolation } from "./test-isolation";

export default function setupTestSandbox(): () => void {
	const root = process.env.DEV3_TEST_ROOT;
	if (!root) throw new Error("DEV3_TEST_ROOT was not configured by the Vitest config");
	return () => cleanupTestIsolation(root);
}
