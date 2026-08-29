# Ship low-battery by pulling it from upstream at build time

## Context

`low-battery` is a set of answer-shaping rules living in `h0x91b/toolbelt-for-agents`.
dev3 is the product that benefits from it most — many parked tasks, re-entry after
hours — but a dev3 user only got it by discovering a second repo, running
`claude plugin marketplace add`, and then selecting the style in `/config`. On every
harness except Claude Code the install was worse: a skill alone is loaded on demand,
so it did nothing until the user edited their own global instruction file. Almost
nobody finished that path, so dev3 ships it itself, on by default.

## Investigation

Three ways to get upstream content into the binary were on the table.

A **git submodule** is out on its face: a submodule comes up empty in a `git worktree`,
and dev3 creates a worktree per task, so every agent would see an empty tree.

A **hand-vendored copy** rots the moment upstream edits a rule, and it makes a human
responsible for escaping ~100 KB of markdown full of backticks and `${...}`.

A **build-time pull** keeps upstream the single source of truth and needs no manual
bump, at the cost of a release not being byte-reproducible from a dev3 tag alone, and
of an upstream commit reaching users without passing dev3 review. The user accepted
that cost explicitly after the risks were laid out.

## Decision

`scripts/generate-low-battery.ts` shallow-clones upstream, reads
`plugins/low-battery/`, and writes `src/shared/low-battery-content.generated.ts`
through the pure transform in `scripts/low-battery-generator.ts`. It runs in `build`,
`build:prod`, `package:win-archive` and in `devPlan` (`scripts/dev.ts`), so a release
and `bun run dev` carry byte-identical content. Every value is emitted through
`JSON.stringify`, never a template literal — that is the escaping problem handed to a
machine. The generated module is **checked in**, so tests and type-checking never need
the network; the build refreshes it.

Compensations for the non-reproducible pull, all of them load-bearing rather than
optional: the upstream commit is baked into the module and surfaced next to the
Settings toggle and in `dev3 doctor`, and a build that cannot reach upstream **exits
non-zero** rather than silently shipping without a feature advertised as on by default.

Installation extends the existing skill installer (`src/bun/agent-skills.ts` →
`applyLowBattery` in `src/bun/low-battery.ts`): the skill goes into the same six agent
config dirs dev3's own skills use, and the Claude Code output style goes into
`~/.claude/output-styles/`. The always-on line every non-Claude harness needs lives
**inside dev3's existing managed block** in `~/.agents/AGENTS.md` — no second managed
region, and removal is the same code path that rewrites the block on every start.

The `outputStyle` key is never taken from a user. `applyLowBatteryOutputStyle`
(`src/shared/low-battery.ts`, pure) allows exactly three outcomes: absent or `default`
→ dev3 selects its style; already any low-battery variant, including the
plugin-namespaced `low-battery:Low Battery` → already on, nothing written; anything
else → left alone, and the settings row names the style it kept and offers a one-click
switch. Turning the toggle off is a real uninstall that removes only what dev3 wrote —
the `outputStyle` key is cleared only when it still holds dev3's own value.

The style name written is `Low Battery`, not the file slug: Claude Code's frontmatter
`name` **replaces** the slug rather than aliasing it (`registeredOutputStyleName` in
`src/bun/agent-accounts.ts`). Getting that wrong is a silent no-op, so a test asserts
the written name against dev3's own resolver applied to the shipped file.

## Risks

An upstream commit reaches users without dev3 review — mitigated by the recorded
revision, not eliminated. A network-less build machine fails the build loudly; that is
deliberate, and it is the one place this design trades convenience for honesty. The
checked-in generated module can drift from upstream between builds, which is visible
in the diff and only ever a stale snapshot, never a wrong one.

## Alternatives considered

Shelling out to `claude plugin marketplace add` — Claude-Code-only, needs network on
the user's machine, and leaves dev3 owning a plugin it cannot uninstall cleanly.
Shipping the monolithic ~49 KB context-file form (`.rules`, `GEMINI.md`) for harnesses
without skill support — rejected as out of scope; skill plus the always-on line is the
delivery for every harness here, and the settings row says plainly which harnesses
dev3 cannot select the format for.
