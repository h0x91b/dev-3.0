/**
 * When each model became available in dev3, keyed by the raw preset `model`
 * slug — the order the launch picker lists models in, newest first.
 *
 * A model added on its launch day carries that day. Everything older was
 * backfilled from git history: the first commit that shipped the slug. That is
 * the earliest provable date, not the vendor's announcement, so bulk preset
 * refreshes give several models one date; the curated DEFAULT_AGENTS order
 * breaks those ties. A harness-specific alias (Cursor's
 * `claude-opus-5-thinking-high`) carries the date of the model it serves.
 *
 * Every model slug in DEFAULT_AGENTS needs an entry — `model-release-dates.test.ts`
 * fails otherwise, so a new model cannot sink to the bottom of the list unnoticed.
 */
export const MODEL_RELEASE_DATES: Record<string, string> = {
	// Claude
	"claude-haiku-5-5": "2026-10-08",
	"claude-sonnet-5-5": "2026-10-05",
	"claude-opus-5-5[1m]": "2026-09-22",
	"claude-fable-5-1[1m]": "2026-09-02",
	"claude-opus-5[1m]": "2026-07-24",
	"claude-sonnet-5": "2026-07-01",
	"claude-fable-5": "2026-06-09",
	"claude-opus-4-8[1m]": "2026-05-29",
	"claude-opus-4-7[1m]": "2026-05-29",
	// Codex
	"gpt-6.1-sol": "2026-09-29",
	"gpt-6-sol": "2026-09-22",
	"gpt-6-luna": "2026-09-22",
	"gpt-6-astra": "2026-09-05",
	"gpt-5.6-luna": "2026-07-08",
	"gpt-5.6-sol": "2026-07-08",
	"gpt-5.6-terra": "2026-07-08",
	"gpt-5.5": "2026-04-24",
	"gpt-5.3-codex": "2026-03-10",
	// Gemini
	"gemini-3.1-pro-preview": "2026-03-13",
	"gemini-3-flash-preview": "2026-03-13",
	"gemini-3.1-flash-lite-preview": "2026-03-13",
	// Cursor Agent
	"claude-opus-5-thinking-high": "2026-07-24",
	"claude-sonnet-5-thinking-high": "2026-07-01",
	"gpt-5.6-sol-xhigh": "2026-07-08",
	"cursor-grok-4.6-high-fast": "2026-09-15",
	"gemini-3.8-flash-high": "2026-09-15",
	"gemini-3.7-flash-high": "2026-09-15",
	"composer-2.5": "2026-07-12",
	// OpenCode
	"openai/gpt-5.5": "2026-04-24",
	"anthropic/claude-opus-4-6": "2026-03-27",
	"anthropic/claude-sonnet-4-6": "2026-03-27",
	"openai/gpt-5.3-codex": "2026-03-27",
	"anthropic/claude-haiku-4-5": "2026-03-27",
	"opencode/big-pickle": "2026-03-27",
	// GitHub Copilot
	"claude-opus-5": "2026-07-24",
	"gemini-3.7-flash": "2026-09-15",
};

/** Slugs that hand the model choice to the agent's own CLI. Not a model, so no
 *  release date — the picker lists them first, as the "let it decide" choice. */
export const AGENT_CHOSEN_MODEL_SLUGS: ReadonlySet<string> = new Set(["auto"]);

/** The `YYYY-MM-DD` release date of a model slug, or undefined when unknown. */
export function modelReleaseDate(model: string | undefined): string | undefined {
	return model ? MODEL_RELEASE_DATES[model] : undefined;
}
