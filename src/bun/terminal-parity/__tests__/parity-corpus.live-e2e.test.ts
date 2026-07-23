/**
 * Proves the CURRENT tmux runner satisfies the backend-neutral parity corpus
 * (MIG-001). Runs every `live` scenario against a real tmux server through the
 * typed TmuxClient. Excluded from the fast suite (see the `test` script's
 * `--exclude '**\/parity-corpus.live-e2e*'`); runs in CI via `bun run test:full`.
 *
 * Platform-specific scenarios are explicitly skipped when the host OS does not
 * match `scenario.platform`. When tmux is not on PATH the whole suite skips.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PARITY_CORPUS } from "../corpus";
import { LIVE_CHECKS, type CheckContext } from "../checks";
import { createTmuxParityHarness, detectTmux, type TmuxParityHarness } from "../tmux-runner";

const TMUX_VERSION = detectTmux();
const isWindows = process.platform === "win32";

function skipForPlatform(platform: string): boolean {
	if (platform === "posix") return isWindows;
	if (platform === "windows") return !isWindows;
	return false;
}

describe.skipIf(!TMUX_VERSION)("tmux runner satisfies the parity corpus", () => {
	let harness: TmuxParityHarness;
	let ctx: CheckContext;

	beforeAll(() => {
		harness = createTmuxParityHarness();
		ctx = { cwd: harness.workDir, reconnect: harness.reconnect };
	});

	afterAll(async () => {
		await harness.runner.dispose();
	});

	const liveScenarios = PARITY_CORPUS.filter((s) => s.verification.mode === "live");

	for (const scenario of liveScenarios) {
		const check = LIVE_CHECKS[scenario.id];
		it.skipIf(skipForPlatform(scenario.platform))(
			`${scenario.id} [${scenario.platform}]`,
			async () => {
				expect(check, `missing check for ${scenario.id}`).toBeTypeOf("function");
				await check(harness.runner, ctx);
			},
			30_000,
		);
	}
});
