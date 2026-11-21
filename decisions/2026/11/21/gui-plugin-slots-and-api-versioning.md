# GUI plugin slots: two kinds, internal migration first, add-only for third parties

Status: Accepted — decided by Arseny on 2026-11-21 (coordinator task seq:2526, plan `cordis-gui-plan.md`). Not yet implemented; Phase 0 of the plan builds it.

## Context

Board views proved the Cordis runtime (`pluggable-board-views-on-cordis`, `board-host-cordis-provision`). The next step moves the rest of dev3's GUI onto plugins, starting with Settings and the four task-header bars. That needs a slot model general enough for every surface, a rule for how much of dev3's internals a built-in may keep using, a security boundary for third parties, and a policy for `EXTENSION_API_VERSION` — today it is `1.1.0` with no rule for when it moves (`docs/extensions-platform.md`, Phase 3).

## Investigation

About 90% of `BoardViewRegistry` (`src/mainview/board-views/registry.ts`) is a generic keyed registry, and `BoardHost`'s Kanban fallback is a generic replace-with-fallback host. The board is the only surface where "show exactly one implementation" makes sense; the task header and Settings are host-owned surfaces many contributors add to. Rewriting Kanban onto the public contract worked because its data was one coherent model; a git or dev-server button needs git, scripts, ports and accounts, which nobody wants to freeze as public API on day one. Extensions have no sandbox, so a plugin that can replace Push or the Accounts section can phish.

## Decision

1. **Two slot kinds.** A **replace** slot shows exactly one implementation behind an in-surface chooser, with an undisableable built-in fallback (the board view; later the sidebar, home and destination bodies). A **contribution** slot collects items from many plugins into a surface the host owns; the host keeps the chrome, the order and the budget, and a failed contributor's items simply vanish (task header, settings sections, commands, task menu, dock panels). The app shell and the terminal renderer stay host-owned, not slots.
2. **Rule 7: public placement, private internals.** A built-in item registers through the same public slot call a third party uses, but its component may keep using internal modules (`api`, existing hooks). Exposing a capability publicly (for example `ctx.task.git`) is a separate, additive step.
3. **Add-only for third parties.** A plugin may add items and sections; it may never replace, hide or displace a built-in item, a whole header region, or a built-in settings section, and may not add a settings category. Third-party header items start in overflow. Reorder, hide, pin and swap are user actions only.
4. **Versioning.** `EXTENSION_API_VERSION` (`src/shared/extensions.ts`) moves on every public PR, so it stays at `1.1.0` through the internal track: **minor** for each additive slot, service, manifest kind or field; **major** for any removal or rename of something an author can touch. Internal PRs (built-ins only) do not bump it. A public bump ships with its docs page, example and `dev3-extensions` skill text in the same PR. The version marks the contract, not a release.
5. **Order: migrate everything internally first, then open piece by piece.** The user's words: "first we fully move ourselves, and only then hand it out to plugins piece by piece". The internal track moves every dev3 surface onto slots with built-ins only and adds no public API: no new manifest kind, no public `ctx.*` service, no example extension, no version bump. Internal helpers a built-in needs may exist but stay non-public. Only after that does an opening track expose slots and services to third parties, one kind at a time, each as its own public PR under rules 3 and 4.
6. **Cordis stays pinned at exactly `4.0.0-rc.11`** until the plan's final reliability phase, where moving to 4.0 stable is one deliberate bump; if it breaks authors, it ships as `EXTENSION_API_VERSION` 2.0.0 with a migration note.

## Tech debt: built-ins on the public contract only

Rule 7 is a deliberate, recorded debt, not the end state. The user's words: internals are fine at this stage, but in the end every built-in must be redone on the public contract. **End state:** every built-in item, section, panel and view runs only on public `ctx.*` services and slot registrations — no `api.request`, no `dispatch`, no internal hook — exactly as `builtin:kanban` does today. The internal track necessarily runs on internals, since it adds no public services. Pay the debt down in the opening track: when a slot kind or service opens, the built-ins it covers move onto the public form in the same PR. The debt is tracked in `docs/extensions-platform.md` until the last built-in is off internals.

## Risks

Until the debt is paid, a public contract that looks complete may not be: built-ins prove placement, not capability, so a third party can hit a wall a built-in never sees. Add-only limits what a plugin can do to a user who genuinely wants a replacement; the user's own swap covers it. Bumping per public PR means many minors once the opening track starts; that is honest, not noise. Internal-first delays third-party value until the whole migration lands, in exchange for a contract shaped by every surface rather than the first two.

## Alternatives considered

Every surface replaceable (rejected: a replaceable shell lets one plugin remove the kill switch's escape hatch). Built-ins on the public contract from day one, like Kanban (rejected for now: Phases 2–3 would first have to freeze git, dev-server, accounts and model-catalog APIs; recorded above as debt instead). Letting plugins replace a header region or a settings section (rejected: no sandbox, so it is a phishing surface). Batched version bumps per release (rejected: the version marks the contract an author codes against). Opening each slot to third parties as soon as its built-ins land (the plan's original order; rejected by the user for internal-first, so the contract is not frozen before every surface has tested it).
