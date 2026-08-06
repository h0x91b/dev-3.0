# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This is a **single-context** repo.

## Before exploring, read these

- **`AGENTS.md`** at the repo root — this repo's primary domain/architecture doc and coding conventions. There is no separate `CONTEXT.md`; `CLAUDE.md` is a symlink to `AGENTS.md`. Also skim `concept.md` (product concept + status), `DESIGN.md` (design system), and `docs/ux/PRODUCT_UX_BIBLE.md` (UX placement) when the work touches product concept, visual design, or UX.
- **`decisions/`** — architectural decision records live here as `decisions/YYYY/MM/DD/slug.md`, NOT under `docs/adr/` (`decisions/README.md` maps the pre-2026-08-06 `NNN-slug.md` names to their new paths). Read the ones that touch the area you're about to work in.

If a referenced file doesn't exist, **proceed silently** — don't flag its absence or suggest creating it upfront. The `/domain-modeling` skill creates domain docs lazily when terms or decisions actually get resolved. New decision records are named `decisions/YYYY/MM/DD/slug.md` — never numbered, see AGENTS.md § Decision records — with the required sections (Context / Investigation / Decision / Risks / Alternatives).

## File structure (single-context)

```
/
├── AGENTS.md            ← primary domain + conventions doc (CLAUDE.md → symlink)
├── concept.md           ← product concept + implementation status
├── DESIGN.md            ← design system
├── docs/ux/             ← UX manifest (PRODUCT_UX_BIBLE.md, ux-architecture.yaml)
├── decisions/           ← ADRs: YYYY/MM/DD/slug.md
└── src/
```

## Use the project's vocabulary

When your output names a domain concept (a task title, a refactor proposal, a hypothesis, a test name), use the terms as they appear in `AGENTS.md` and the existing code (e.g. "worktree", "task", "project", "surface", "design token", "push message"). Don't drift to synonyms the project doesn't use.

If the concept you need isn't documented yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision-record conflicts

If your output contradicts an existing decision record, surface it explicitly rather than silently overriding:

> _Contradicts `decisions/2026/07/05/pin-tmux-3.6-vendored-keg.md` — but worth reopening because…_ (cite the filename, never a bare number)
