# Agent launch profiles: three named pointers an agent names, a human owns

Design record. No code ships with it; the implementation is a separate task.

## Context

A coordinator creates and launches tasks, and today it cannot say anything about how much
machine the child deserves: `dev3 task create` has no agent flag, and the approval dialog
preselects the one global default (`defaultAgentId`/`defaultConfigId`). Every child therefore
starts on the same preset, whether it renames a symbol or decides an architecture. The user
wants most work offloaded onto cheap models without the expensive model quietly doing that work
instead, and without managing a model choice per task.

`RecommendedTier` (`practical`/`smart`) is adjacent and not the same thing: it binds catalog
models into one preset's role slots. This is about which preset a launch starts on.

## Decision

**Three launch profiles**, named by the user and frozen: **Microtask**, **Workhorse**,
**Think Tank**. A profile is a thin pointer `(agentId, configId, accountId?)` in
`GlobalSettings` (`~/.dev3.0/settings.json`), the same shape as `favorites`. **Workhorse is the
existing global default**, same fields — a user who configured nothing already has it.

Expected balance, stated so it can be measured later: roughly 70 % Microtask, 25 % Workhorse,
5 % Think Tank.

1. **The agent names a class of effort, never a model.** `--profile microtask|workhorse|think-tank`
   is **mandatory** on `dev3 task create --run` and on `dev3 task move --status in-progress`
   when the caller is a task agent; a missing flag exits with a new unique code whose error text
   is the rubric itself. There is no fourth value: an agent that could name a preset would pull
   fashionable model names out of its own memory and route around the user's configuration.
2. **The rubric.** Microtask when **all** hold: the brief names what and where (files, functions,
   commands), no design choice is left, the expected diff is small (~≤3 files), and verification
   is a known command. Otherwise Workhorse. **Anything about how a surface looks is Workhorse**
   regardless — small models do visual work badly. Think Tank only when the user asked for it or
   the task *is* a bounded decision with little code volume; a hard or large implementation is
   not Think Tank. Ambiguity falls to Workhorse, because a stuck cheap agent is paid for in the
   coordinator's attention.
3. **The profile rides the launch request.** It travels in `AgentLaunchRequest` next to
   `defaultPriority`, so the bun-side auto-approval uses it even with no client on screen. It is
   one profile per request; several variants of one task share it.
4. **Fallback is Workhorse and only Workhorse**, stated on screen. An unset mapping, an
   uninstalled harness, positive not-signed-in evidence, or a deleted preset all resolve to
   Workhorse — never up to Think Tank, never sideways into a harness the user never chose. The
   dialog's dropdown always names what Launch will actually start.
5. **Think Tank does not self-approve on the ordinary timer.** It gets its own delay in Settings,
   `0` = always wait.
6. **Seeded mappings, from the only locally provable signal: which harness the user already
   launches on.** File presence is not proof of a working subscription; a working default is.

   | Installed | Microtask | Workhorse | Think Tank |
   |---|---|---|---|
   | Claude Code + Codex | GPT-5.6 Luna X-High | Opus 5 | GPT-6 Astra X-High |
   | Codex only | GPT-5.6 Luna X-High | current default | GPT-6 Astra X-High |
   | Claude Code only | Sonnet 5 | Opus 5 | Fable 5.1 X-High |
   | Neither / anything else | current default | current default | current default |

   Seeds are marked as such in Settings and one click replaces them; a user-set row is never
   re-seeded. The marker is driven by key presence in the stored object, not by comparing the
   value to the seed.
7. **The task remembers both** `launchProfile` (what ran) and `requestedLaunchProfile` (what the
   agent asked for), so overrides are countable. New optional fields in existing file content —
   older app versions ignore them, exactly as they do `accountId`. No path, no rename, no
   migration.
8. **One new Settings category, `Agent launch profiles`**, and it **takes** the default-agent
   controls out of Settings → Agents rather than duplicating them: Agents stays the library of
   what exists, the new category owns what gets launched. The Think Tank timer lives there too,
   cross-linked with the global one.
9. **The dialog changes, the manual launch surfaces do not.** `AgentLaunchRequestModal` gains a
   profile dropdown at the head of its configuration region, a line naming the preset it resolves
   to, and moves the per-variant Harness→Model→Mode cascade behind one `Advanced` disclosure.
   Editing a row by hand flips the display to Custom. `LaunchVariantsModal`, `SpawnAgentModal`
   and `BugHuntersLightbox` are untouched.

## Risks

- **The rubric is prose in a capped prompt.** The classification text lands in
  `COORDINATOR_PROMPT`, whose composed body is bounded by the Windows command-line limit
  (`AGENT_SKILL_BODY_LIMIT`). Adding ~400–500 characters means cutting the same amount; raising
  the cap moves the failure into the OS, where there is no error message.
- **The UX manifest has no room.** Measured 2026-09-12 on `main`: `PRODUCT_UX_BIBLE.md` 11 bytes
  under its 128 KB cap, `ux-architecture.yaml` 3 bytes under 117 KB, `UX_DECISIONS.md` 60 bytes
  under 81 KB. The placement rules this design needs are ~1.3 KB, so the implementation must
  compact first and justify any ratchet in `ux-docs-budget.test.ts` itself.
- **A seeded Microtask can be a model the user cannot actually run.** dev3 reads credential files,
  never validity, and never which models a subscription exposes; discovering that costs a paid
  call. The failure surfaces as a dead pane, which is the same failure an unusable preset has
  today.
- **`profiles` becomes ambiguous in Settings** — Accounts already owns "API profiles". Both stay
  qualified in every locale; neither is ever shortened to "Profiles".
- **A mandatory flag breaks every agent that has not read the new prompt**, once. The error text
  carries the rubric, so the retry is self-taught.

## Alternatives considered

- **Profile as a tag on `AgentConfiguration`** — several presets could claim one profile and the
  choice between them becomes a new question; it also means editing 98 records.
- **Optional flag defaulting to Workhorse** — nothing would ever be classified, and the cheap
  path would stay unused. The user chose the forced decision deliberately.
- **A per-variant profile** — variants are attempts at one task, so one class of effort covers
  them; a per-row control is N copies of one global choice.
- **`--profile custom --agent … --config …`** — rejected as the channel through which an agent
  starts picking models from memory.
- **Priority as the signal** — P0/P1 would have become a proxy for "expensive", which is a
  different axis from urgency and would spend money on impatience.
- **Auto-escalating a stuck Microtask** — that is automatic spawning under another name, and it
  is explicitly out of scope; the coordinator decides what to do with a stuck child.
- **Delivering the profile into the launched child's prompt** so Think Tank decides and Microtask
  reports early — considered and dropped by the user: the brief already carries the job.
