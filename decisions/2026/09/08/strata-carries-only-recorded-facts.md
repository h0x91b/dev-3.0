# Strata is a port of the demo's craft, not of its data

## Context

Experiment 3 was specified against a single-file reference demo (`dev3-strata.html`,
SHA-256 `66e3e613857d4e371e979335e353c69200d84904f285667b7d307344b1263e02`, pinned in this
task's notes). The demo is a complete piece of work: a hand-written WebGL2 engine with no
dependencies, hexagonal district platforms, machine-shaped task models by role, message
beams, floating labels with occlusion avoidance, and a full app shell.

It is also a **scenario**. Its data is a reproducible fictional event log with a written
narrative: `DISTRICTS`, `TASKS` with hand-authored state histories, `MESSAGES`, `CHAPTERS`
(six chapters of story narration), a `SIM` object whose buttons mutate that fiction
("Retry delivery", "Approve"), and `addStress()`, which invents a hundred synthetic tasks
on a click. The brief was "keep as much of the demo as possible, but only real data", and
those two halves pull in opposite directions on precisely these features.

## Decision

**Every visual and interaction idea was ported. No fictional or mutating feature was.**

Ported, in `src/mainview/components/agent-traffic/strata/`: the engine
(`strata-gl.ts`, `strata-mesh.ts`, `strata-math.ts` — shaders and geometry primitives
carried over near-verbatim), the deck and machine geometry (`strata-scene.ts`), the orbit
camera and its pointer grammar (`strata-camera.ts`), and the ranked label placement with
occlusion avoidance (`strata-labels.ts`).

Deliberately not ported, and why each one is a data-integrity problem rather than a scope cut:

| Demo feature | Why it stayed out |
|---|---|
| `SIM` + the Retry / Approve buttons | They mutate invented state. Agent traffic is an `Observed` surface (§5.9); a button that changes what the log says never existed |
| `CHAPTERS` narration | A written story about a board it cannot see. §5.9 forbids narratives |
| `addStress()` | Fabricated records |
| The compose modal, the Terminal inspector tab, `exportLog()` | §5.9 names all three explicitly: no composer, no terminal, no import/export |
| The demo's own topbar (logo, project, theme select, help, fullscreen) | The app's header already owns that. The UX bible forbids the traffic destination growing "own chrome above the header" |
| Progress semantics on the worker's three shelves | §5.9 forbids progress. The shelves survive but count **distinct recorded statuses** from `Task.movements[]`, which is a count of facts. A repeated status counts once, and a card with no movements shows none |
| The demo's light theme | Not a cut — a fix. See Risks |

The data mapping is in `strata-model.ts`, and every field traces to something dev3 wrote
down: a district is a project; a machine's silhouette is its recorded `taskType`; its
colour is `projectTaskAt(task, cursor.at).status` through the app's own `useStatusColors`,
with `null` rendering as neutral ink that provably is not in `STATUS_COLORS`; a route's
kind is the row's delivery verdict. The "while you were away" line is two measured numbers
and a span, never a canned sentence. One district is derived rather than read — the quiet
band holding cards the window has no message for — which is the same idea Experiment 2's
layout already has, drawn as its own platform.

## Investigation

Four defects were found by driving the stage in a browser, not by reading it:

1. The camera framed `sceneExtent` (the padded substrate radius) and aimed at the world
   origin. The decks rendered at about a third of their legible size and the far one hung
   off the bottom edge. Two hand-tuned multipliers each fixed one stage and broke another;
   `framingDistance` now derives the distance from the field of view and the measured
   stage aspect, taking the binding one of a foreshortened-height fit and a width fit.
   `strata-camera.test.ts` checks the fit independently of the formula.
2. Raising the fit exposed a second bug behind it: `DISTANCE_MAX` was 350 and the
   projection's far plane a fixed 650, so a large board on a narrow stage could not be
   framed and, past 650, silently vanished. The ceiling is 900 and the far plane now
   follows the camera.
3. Card labels were placed before deck names and the failed-route callout, so a card label
   would park on top of the district it stood on. Order is now reversed and both claim
   their boxes. Labels also keep a 6px gap; at zero, four cards on one deck produced four
   labels touching edge to edge and reading as a list.
4. The metric strip sat top-right, underneath the activity panel, and was never visible.

## Risks

- **The scene palettes are hex literals, not design tokens** (`strata-palette.ts`). A
  shader cannot resolve a CSS custom property and reading every material through
  `getComputedStyle` per frame would cost a layout flush per draw — the same carve-out
  `STATUS_COLORS` already has. The risk is drift if the app's surfaces are re-themed. It
  is mitigated by having two complete palettes rather than one plus an override: the
  reference demo had exactly that, and its light theme left the deck labels white on white,
  legible in one of its two themes. Status colours are never duplicated here.
- **One shared-file edit was unavoidable and is not ours by default.** The picker's third
  option was clipped mid-word by the 240px cap `.traffic-toolbar > div` applies to its
  filter fields. Fixed in `traffic-orbit.css` by exempting `.traffic-experiment`, since a
  radiogroup should never have inherited a field width.
- **`AgentTrafficScreen.tsx` has three concurrent authors** while Seq 1823 integrates. The
  picker option, the stage ternary and the arrow-key cycle are one commit on this branch so
  the stage can be QA'd end to end, and Seq 1823 owns the canonical insertion.
- **A worker's antenna reaches y ≈ 4.0**, above the undelivered cross at 3.77, so a
  height probe cannot distinguish them on that role. The test uses the reviewer gantry,
  which tops out at 3.35. Anyone changing the worker's height should not assume otherwise.

## Alternatives considered

- **Port the demo whole, feeding it real data where convenient and its fiction elsewhere.**
  Rejected: a stage where some cards are real and some are scenario is worse than either,
  and there is no marking that survives a screenshot.
- **Use a 3D library (three.js) instead of porting the engine.** Rejected: it would be the
  only 3D dependency in the tree, the demo's look is a product of these exact shaders, and
  the whole engine is ~330 lines.
- **Reuse `layoutTraffic` from `nodes-layout.ts`.** Rejected: it is a 2D grid, and Seq 1827
  owns its eligibility block. Strata has its own 3D placement and derives the quiet band
  itself.
- **Keep the demo's `state` vocabulary** (`running`, `waiting`, `unreached`, `human`,
  `sleeping`…). Rejected: those are scenario words. The stage speaks `TaskStatus` plus two
  derived flags — `undelivered` from the message log and `hibernated` from the board — so
  the labels agree with every other surface in the app.
- **Put the scene-mode switch in the screen toolbar** next to the experiment radiogroup.
  Rejected: it is a sub-mode of one presentation and would be a dead control on the other
  two, or the toolbar's contents would change under the user. It lives on the stage.
