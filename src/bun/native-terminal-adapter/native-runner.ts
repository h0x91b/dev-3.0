/**
 * Native `ParityRunner` harness (seq 1254). Points the registry's additive
 * namespace at a throwaway tmpdir and hands out a fresh single-view adapter plus
 * a `reconnect()` that models a NEW controller process rediscovering the same
 * on-disk sessions. Mirrors `terminal-parity/tmux-runner.ts`'s harness so the
 * shared corpus checks drive native exactly as they drive tmux.
 *
 * Real-runtime only: the native host owns a live `Bun.Terminal`, so this is
 * exercised from a standalone `bun` e2e (vitest stubs the Bun global). The
 * bounded parser-state scrollback is widened here so a large capture burst fits
 * the snapshot the adapter reconstructs from.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SESSIONS_DIR_ENV } from "../native-terminal-registry/paths";
import { assertNativeTerminalRuntime } from "../../shared/native-terminal-runtime";
import { NativeSingleViewAdapter } from "./adapter";

const PARSER_SCROLLBACK_ENV = "DEV3_NATIVE_SESSION_PARSER_SCROLLBACK";
const SNAPSHOT_SCROLLBACK_ENV = "DEV3_NATIVE_SESSION_PARSER_SNAPSHOT_SCROLLBACK";
/** Wide enough to hold the parity high-output burst in the bounded snapshot. */
const HARNESS_SCROLLBACK = "4000";

export interface NativeParityHarness {
	readonly runner: NativeSingleViewAdapter;
	/** A writable directory a check may use as a session cwd. */
	readonly workDir: string;
	/** A fresh controller on the same on-disk namespace (reconnect scenario). */
	reconnect(): NativeSingleViewAdapter;
	/** Tear down the owner runner and remove the throwaway namespace + workdir. */
	dispose(): Promise<void>;
}

/**
 * Detect a usable native-terminal runtime; returns the Bun version string or
 * null (Windows below the ConPTY floor, or no Bun runtime). Mirrors
 * `detectTmux()` so the e2e can `skip` cleanly instead of failing.
 */
export function detectNativeRuntime(): string | null {
	if (typeof Bun === "undefined" || typeof Bun.version !== "string") return null;
	try {
		assertNativeTerminalRuntime({ platform: process.platform, bunVersion: Bun.version });
		return Bun.version;
	} catch {
		return null;
	}
}

/** Create an owner native parity harness on a fresh throwaway namespace + workdir. */
export function createNativeParityHarness(): NativeParityHarness {
	const previousEnv = {
		sessions: process.env[NATIVE_SESSIONS_DIR_ENV],
		scrollback: process.env[PARSER_SCROLLBACK_ENV],
		snapshotScrollback: process.env[SNAPSHOT_SCROLLBACK_ENV],
	};
	const root = mkdtempSync(join(tmpdir(), "dev3-native-parity-"));
	const sessionsDir = join(root, "native-sessions");
	const workDir = join(root, "work");
	mkdirSync(workDir, { recursive: true, mode: 0o700 });
	process.env[NATIVE_SESSIONS_DIR_ENV] = sessionsDir;
	process.env[PARSER_SCROLLBACK_ENV] = HARNESS_SCROLLBACK;
	process.env[SNAPSHOT_SCROLLBACK_ENV] = HARNESS_SCROLLBACK;

	const runner = new NativeSingleViewAdapter({ owner: true });
	return {
		runner,
		workDir,
		reconnect: () => runner.reconnect(),
		async dispose() {
			await runner.dispose().catch(() => {});
			restoreEnv(NATIVE_SESSIONS_DIR_ENV, previousEnv.sessions);
			restoreEnv(PARSER_SCROLLBACK_ENV, previousEnv.scrollback);
			restoreEnv(SNAPSHOT_SCROLLBACK_ENV, previousEnv.snapshotScrollback);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
