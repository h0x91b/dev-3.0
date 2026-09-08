/**
 * Which agent CLI version a model needs, and the pure comparison used to decide
 * it. A model id newer than the installed CLI does not fail locally: Codex
 * prints "Model metadata for <id> not found", talks to the API anyway, and the
 * API answers 400 "requires a newer version of Codex". The pane then dies with
 * no dev3-level explanation, which reads as an auth or config problem (#1667).
 *
 * The requirement is keyed on the MODEL, not on a preset, so a preset the user
 * built by hand with the same model is gated identically.
 */

export interface CliVersion {
	major: number;
	minor: number;
	patch: number;
}

/** First `major.minor.patch` in a `--version` line (`codex-cli 0.153.4`). */
export function parseCliVersion(output: string): CliVersion | null {
	const match = output.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
	if (match == null) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isCliVersionAtLeast(version: CliVersion | null, threshold: CliVersion): boolean {
	if (version == null) return false;
	if (version.major !== threshold.major) return version.major > threshold.major;
	if (version.minor !== threshold.minor) return version.minor > threshold.minor;
	return version.patch >= threshold.patch;
}

/**
 * Minimum Codex CLI release per model dev3 ships a preset for. `null` means
 * "no known floor" — every Codex release dev3 supports can run it.
 *
 * `gpt-6-astra` first appears in `codex-rs/models-manager/models.json` at
 * upstream tag `rust-v0.153.1`; `rust-v0.153.0` does not carry it. Verified
 * against the openai/codex contents API per tag, 2026-09-08. The API also
 * enforces a minimum client version of its own, which cannot be probed without
 * spending a request — so an install between 0.153.1 and the reporter's known
 * good 0.153.4 is untested, and this floor is the earliest release where the
 * CLI itself knows the model.
 *
 * `src/shared/__tests__/agent-model-cli-requirements.test.ts` fails when a
 * builtin Codex preset names a model absent from this map: adding a preset for
 * a fresh model must state its requirement, even when that is `null`.
 */
export const CODEX_MODEL_MIN_CLI_VERSION: Readonly<Record<string, string | null>> = {
	"gpt-6-astra": "0.153.1",
	"gpt-5.6-luna": null,
	"gpt-5.6-sol": null,
	"gpt-5.6-terra": null,
	"gpt-5.5": null,
};

export type ModelCliSupport =
	| { status: "ok" }
	/** No floor is known for this model, or the CLI version could not be read. */
	| { status: "unknown" }
	| { status: "too-old"; model: string; installed: string; required: string };

/**
 * Whether the installed Codex can run `model`. Unknown beats a guess in both
 * directions: an unreadable `codex --version` and an unlisted model both return
 * "unknown", so the launch proceeds exactly as it does today.
 */
export function evaluateCodexModelSupport(
	model: string | undefined | null,
	versionText: string | null | undefined,
): ModelCliSupport {
	if (!model) return { status: "unknown" };
	const required = CODEX_MODEL_MIN_CLI_VERSION[model];
	if (required == null) return { status: "unknown" };
	const parsedRequired = parseCliVersion(required);
	const installed = versionText != null ? parseCliVersion(versionText) : null;
	if (parsedRequired == null || installed == null) return { status: "unknown" };
	if (isCliVersionAtLeast(installed, parsedRequired)) return { status: "ok" };
	return {
		status: "too-old",
		model,
		installed: `${installed.major}.${installed.minor}.${installed.patch}`,
		required,
	};
}
