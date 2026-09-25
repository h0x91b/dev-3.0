# Harness token efficiency audit

Status: measurement foundation and one opt-in experiment; no demonstrated reduction in cost per completed task yet. Baseline captured on 2026-09-25. The production prompt and model selection remain unchanged by default.

## Ownership map

| Layer | Implementation | What dev3 controls |
| --- | --- | --- |
| Launch and task setup | `src/shared/agent-adapters/{claude,codex,omp,template}.ts`, `src/bun/agents.ts` | CLI arguments, static lifecycle instructions, task description and interpolated user preset |
| Installed context | `src/shared/agent-skill-content.ts`, `src/bun/agent-skills.ts` | Full family-specific protocol, skill descriptions, fallback files and managed global instructions |
| Request assembly, core tools, history, compaction | External Claude Code, Codex, Gemini, Cursor and omp CLIs | No in-process model request builder or tool registry in dev3; cannot reorder actual API messages or set cache boundaries here |
| Provider routing | `src/shared/model-catalog.ts`, `src/bun/model-sidecar.ts` | Provider/model bindings and Bifrost process/configuration; request transformation belongs to the bundled sidecar |
| Existing usage | `src/bun/rpc-handlers/agent-usage{,-parse}.ts`, `src/shared/agent-pricing.ts` | Local daily transcript aggregation and API-equivalent rates; not task outcomes or request-source attribution |
| Conversation projection/retrieval | `src/shared/conversation-parsers/`, `src/bun/conversation-{parse,search,handoff}.ts` | Reading, indexing, archiving and cross-harness retellings; these are not the original API requests |
| Agent coordination | `src/bun/agent-message-spill.ts`, `src/shared/agent-message-envelope.ts` | Long messages already spill to files; native CLI subagents and their tools remain owned by the CLI |

Codex injects `CODEX_SKILL_BODY` through `developer_instructions`. Claude normally uses `--append-system-prompt-file`, with an inline fallback; omp also accepts a protocol file. Task-specific material is separate in `buildTaskPrompt`; Cursor/OpenCode append their protocol after that variable text, so their final cache layout merits a separate experiment. There is no demonstrated volatile value in the dev3 protocol constant. Installed skills and user rules also enter context through the external harness. Sorting the model catalog would not prove deterministic tool ordering on the wire.

Bifrost already enables local metadata logging with `disable_content_logging: true`; its SQLite log is not a capture of rendered requests. Native subscriptions bypass the sidecar. No new remote telemetry, vendor events or content logging were added: neither anonymous-egress nor opt-out rules acquire another channel. The new audit reads only explicitly supplied local files and prints local metadata.

## Baseline and limits

The diagnostic sample is the first 13 native `token_usage_record` entries from this task's parent Codex rollout, before the first implementation commit. It is a real ongoing coding run, not a representative completed-task evaluation. Child agents were running; their spend is excluded from this frozen parent sample and must be included in an eventual task comparison. No sibling task or variant transcript was read.

The content-free numeric audit is preserved in [harness-baseline-2026-09-25.json](harness-baseline-2026-09-25.json). Original prompts, file paths and native identifiers remain outside the repository.

| Billing category | Tokens | Standard short-context API-equivalent USD | Share of known cost |
| --- | ---: | ---: | ---: |
| Uncached input | 94,006 | 0.940060 | 49.99% |
| Cache reads | 815,104 | 0.815104 | 43.35% |
| Cache writes | 0 reported | 0 | 0% |
| Output, including reasoning | 2,504 | 0.125200 | 6.66% |
| Total | 911,614 | 1.880364 | 100% |

The recorded model was GPT-6 Astra. These are the existing standard-rate estimates ($10/$1/$12.50/$50 per million uncached/read/write/output tokens), not an invoice. Service tier, regional pricing, context tier and subscription allowances are not reconstructed. Source of all measured spend above: parent request totals; its division into system/tools/history is **unattributed**.

All 13 requests reported some cached input (100% request-hit share); cached tokens were 89.66% of input. The first request reported 33,939 input tokens and the thirteenth 103,973. There was one user task turn and 13 model requests, illustrating why those denominators must stay separate. Completed tasks: zero; cost per completed task and quality delta: unavailable.

The rollout exposes model-facing message fragments, not complete wire requests with tools and hidden instructions. Inspection found:

| Visible source | UTF-8 bytes in frozen sample | Interpretation |
| --- | ---: | --- |
| Base instructions recorded in session metadata | 21,428 | Snapshot, not evidence of every request's serialized prefix |
| Developer messages | 57,717 | Includes 55,017 bytes of lifecycle/skill/environment setup |
| User messages, including repository/environment setup | 33,554 | Includes 33,431 bytes of injected setup |
| Tool results | 241,945 | Largest observed added payload; includes repeated protocol and long reads |
| Tool arguments | 7,544 | Added content, not tool schemas |
| Assistant text | 735 | Excludes tool calls and encrypted reasoning |

These are exact byte counts, not tokens and not billing allocations. The installed tokenizer does not support this model; no chars-per-token heuristic is presented as measurement. Static tokens/request, source × billing-type cost, complete tool-schema size, serialized-prefix hashes and compaction loss cannot be recovered from this sample. The report does not distribute cached tokens proportionally across visible text: that would invent precision.

The sample contains ten `exec`, two `spawn_agent` and one `send_message` calls: each appeared in 1/1 sampled runs. That is not enough to select an offloading threshold. Codex's output records here do not provide a uniform error flag; an `exec` call can succeed while a nested command exits nonzero. Per-tool semantic error rates are therefore unknown, not zero. A production comparison needs classified tool failures from the owning harness, including errors hidden inside nested tool orchestration.

## Ranked opportunities

The requested spend × removable fraction ÷ risk score cannot yet be calculated by source. This provisional order uses observed duplication, visible payload size and ownership; it must be reranked using completed-task measurements.

| Rank | Layer and change | Estimated saving and basis | Quality risk / validation | Rollback |
| --- | --- | --- | --- | --- |
| 1 | Correct cache-write accounting and add task-level audit | No token saving; prevents false cost conclusions. Unsplit Claude writes previously contributed zero cost | Low; numeric regressions, duplicate events, mixed TTLs, unknown rates | Revert accounting/audit commits |
| 2 | Compact installed skill when protocol is already injected | Removes one repeated full protocol read and potentially two startup CLI calls. Exact rendered byte delta below; dollar delta unmeasured | Flagged; validate lifecycle compliance, fallback and native hooks on realistic tasks | Disable installer flag and reinstall; new sessions receive full skills |
| 3 | Large tool-result file offload in owning harness | Observed tool-result payload is 241,945 bytes; removable share unknown because retrieval may add turns | Medium; preserve complete output, compare recovery reads, failures and final code | Harness-specific experiment off |
| 4 | Discover infrequent skill/MCP definitions on demand | Developer setup is large; individual schema costs and use rates unavailable | Medium; first-turn discovery/tool errors, authentication failures and cold-start tasks | Restore tool-loading configuration |
| 5 | Cache boundaries and deterministic tool serialization in external harness/sidecar | Current input-token cache share is already 89.66%; cannot infer remaining avoidable misses | Medium; raw request hashes plus provider usage; preserve reasoning items | Revert owner-level serialization change |
| 6 | Shorter compaction / richer retrieval | No measured baseline or supported dev3 request-loop hook | High; long-task continuation and missing-detail retrieval evals | Existing harness compaction/retrieval |
| 7 | Routing, effort defaults, worker models or delegation policy | Proposal only; external study percentages are not estimates for dev3 | High; measure whole task tree, success, repair turns and latency | Existing user-owned launch profiles |

No instruction asks the model to work less or save tokens. No change drops reasoning, changes model defaults, truncates runtime tool output, or silently switches models.

## Changes and prompt disposition

The safe accounting change assigns Claude's unsplit cache-creation tokens, including a partial TTL breakdown's remainder, to the documented five-minute default. Fully specified TTL buckets keep their original costs. This fixes measurement, not consumption.

The full injected system/developer protocol is retained: its diff is empty. Every original protocol line is **keep** in the injected body and **move** to a complete sibling fallback for the compact skill; no lifecycle rule is deleted. Only the redundant load instruction and wrapper are rewritten.

The experiment is off by default. `DEV3_COMPACT_AGENT_SKILLS=1` opts the installing process into short wrappers for Codex, omp and shared generic skill locations. The full original skill, including its startup instructions, is written first beside the installed skill, for example `~/.agents/skills/dev3/PROTOCOL.md`. Claude's existing short skill is unchanged. This adds files without renaming or migrating any user state.

| Generated POSIX skill | Original bytes | Compact bytes | Removed from a skill read |
| --- | ---: | ---: | ---: |
| Codex | 28,864 | 799 | 28,065 (97.2%) |
| omp | 28,640 | 799 | 27,841 (97.2%) |
| Generic/shared | 28,579 | 799 | 27,780 (97.2%) |

These are rendered builder measurements, not source-template lengths. The complete reference remains available. Dollar savings depend on removed tokens, later requests, cache eligibility and additional fallback reads; they are unmeasured. For a removed block of `d` tokens consumed once uncached then cached `n` times, the conditional estimate is `d × (uncached_rate + n × cached_rate) / 1e6`, adjusted for cache writes and any extra requests.

Prompt diff ledger (covers all changed text; unchanged full protocol is kept):

| Text in generated context | Disposition | Reason |
| --- | --- | --- |
| Mandatory skill-load description | Rewrite: follow injected protocol; load fallback when absent | Loading an already-injected reference duplicates context |
| Frontmatter name and user-invocable setting | Keep | Skill discovery and explicit invocation still work |
| Full protocol plus startup section inside SKILL.md | Move verbatim to PROTOCOL.md | Preserve standalone behavior and every instruction without unconditional rereading |
| Compact heading and injected-protocol detection paragraph | Rewrite | State which source is authoritative, including family-specific lifecycle rules |
| Fallback paragraph and `dev3 --help` pointer | Rewrite | Make missing context and command reference discoverable |
| Managed global AGENTS block's numbered mandatory reload | Rewrite as conditional load | Otherwise that block would force the duplicate read despite the short description |
| Managed block's shell guidance and optional Low Battery text | Keep | Existing environment and user style constraints |
| Injected `CODEX_SKILL_BODY`, other family bodies, model/effort settings | Keep, byte-identical | No model behavior/default changes without an evaluation |

To try it after building this branch's CLI, run `DEV3_COMPACT_AGENT_SKILLS=1 dev3 install-skills` in an isolated evaluation installation. Check that the selected `SKILL.md` is short and its installed fallback (for example `~/.agents/skills/dev3/PROTOCOL.md`) is complete; test both dev3-launched and standalone sessions. For a persistent experiment, start the app with the same flag: app startup and settings-triggered reinstalls otherwise restore the default. To roll back, run `DEV3_COMPACT_AGENT_SKILLS=0 dev3 install-skills` and start fresh sessions. Removing the flag alone does not rewrite files already installed. No live installation was changed during this audit.

## Run the local task audit

Create a local manifest outside the repository. Paths are relative to its directory unless absolute; the task ID is only a local grouping key and is not printed. Include all attempts and children, even for failed tasks:

```json
{
  "tasks": [
    {
      "id": "task-a",
      "completed": true,
      "transcripts": [
        { "source": "codex", "path": "parent.jsonl", "role": "parent" },
        { "source": "claude", "path": "worker.jsonl", "role": "subagent" }
      ]
    },
    {
      "id": "task-b",
      "completed": false,
      "transcripts": [
        { "source": "codex", "path": "failed-attempt.jsonl", "role": "parent" }
      ]
    }
  ]
}
```

```bash
bun scripts/audit-harness-cost.ts /path/to/manifest.json > /path/to/audit.json
```

Check request counts, `tokens`, `knownCostUsd`, `costByRole`, cache shares and per-transcript gaps. `apiEquivalentCostPerCompletedTaskUsd` divides the whole cohort's cost, including failed tasks and children, by completed tasks. It is null when none completed or supplied usage cannot be fully accounted for. Unknown models stay unpriced; a known-cost subtotal is explicitly partial. Duplicate task IDs, files, copied transcripts or requests assigned to different tasks are rejected rather than double-billed. Native Codex response records supersede duplicate legacy event counters. Claude message snapshots are grouped by message/request identity.

When legacy and native Codex records coexist, legacy cumulative counters must match a cumulative native snapshot before `suppliedUsageAccounted` can be true. Otherwise historical spend may be missing and the total remains unknown. The flag describes only supplied usage, never proof that the entire task tree was included.

No directory scan, provider call, global state change or output-file write is performed by the audit itself. It emits numeric metadata, ordinal task/request indices and model names; source paths, prompt/tool content, timestamps and native identifiers are excluded. The manifest is the authority for attribution and completion: the tool cannot discover missing child sessions, verify a success verdict or reconstruct provider invoices. Parsed user-turn counts can include setup boundaries and are not semantic human-interaction counts. Per-tool call names and classified semantic error rates remain a gap; explicit error flags and unknown outcomes are reported separately.

## Provider facts checked

OpenAI caching is model-dependent: GPT-5.6+ supports explicit boundaries, a 1,024-token visible minimum and 30-minute retention; earlier models use implicit caching and model-specific retention. Keep stable instructions/tools before variable setup and preserve reasoning/history. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). GPT-6 Astra standard short-context rates match the estimate above; fast, long-context and regional tiers differ. [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

Claude supports automatic or explicit ephemeral caching, default five-minute TTL and an optional hour. Minimums vary by model (for example Sonnet 4.6: 1,024; Opus 4.6: 4,096). [Claude caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Sonnet 4.6 rates per million are $3 input, $15 output, $0.30 reads, $3.75 five-minute writes and $6 hour writes. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing). Other configured providers need their own billing verification; native model identity alone does not establish a routed provider's bill.

## Experiment plan and release gate

1. Freeze a corpus of completed real tasks across a small edit, failing test, code investigation, long repair, resumed session, scratch task, handoff and missing-tool/error recovery. Keep user phrasing, model, effort, CLI version and completion rubric fixed. Add standalone launch without injected protocol for each affected family.
2. Use separate test homes/installations for control and treatment. The flag changes installed files shared by sessions; it cannot be randomized safely per turn or per task within one shared installation. Never reinstall global skills in the middle of a comparison.
3. Record all parent and child transcript paths, every attempt, completion verdict, duration and retained diff. Grade task success blind to treatment. Human repair/reopened tasks count against success; board status alone is insufficient.
4. Compare total cohort cost divided by completed tasks (including failed-attempt costs), request count, actual user turns, cached-input share, tool errors and latency. Report unpriced/missing usage separately; do not treat it as zero spend. Repeat cold and warm cache cases because a smaller prefix can lose eligibility.
5. Pre-register a quality non-inferiority margin and sample size from control variance, with confidence intervals on paired task results. No observed failure in a tiny unit suite does not prove equal task quality. Keep treatment disabled unless cost falls and every quality guardrail stays within its declared tolerance. Record null results and regressions.

No before/after production quality claim or end-to-end saving is made here. The provided benchmark percentages are contextual evidence only.

## Validation performed

- `bun run lint`: passed with no TypeScript errors.
- Skill content, installation, shared-home behavior, adapters and launch golden tests: 315 backend tests passed; CLI skill installation: two tests passed.
- Audit, conversation parser, pricing, usage parser/handler and decision-record naming suites: 82 tests passed, including 18 audit cases. These cover cache-write splits, repeated snapshots, mixed billing streams, upgraded transcripts, incomplete usage, failed attempts, subagents and content exclusion.
- Real-data audit: the frozen 13-request snapshot reproduces $1.880364 exactly to floating-point precision. A later parent plus two-child snapshot contained 91 identified records and $12.827402 in API-equivalent spend ($6.149896 parent, $6.677506 children). This checks tree aggregation, not treatment savings; the task was still ongoing, so cost per completed task correctly remained null.
- Script `--help` succeeds; an unreadable manifest exits nonzero with an explanatory message that omits its path. No app UI, live skill installation, external API inference or state migration was exercised.

Focused checks can be repeated with:

```bash
bun run lint
bunx vitest run --config vitest.config.bun.ts src/bun/__tests__/harness-audit.test.ts src/bun/__tests__/agent-skills.test.ts src/bun/__tests__/agent-skills-install.test.ts src/bun/__tests__/agent-pricing.test.ts src/bun/rpc-handlers/__tests__/agent-usage.test.ts src/bun/rpc-handlers/__tests__/agent-usage-handler.test.ts
bunx vitest run --config vitest.config.cli.ts src/cli/__tests__/install-skills.test.ts
```
