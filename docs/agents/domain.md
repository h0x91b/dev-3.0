# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This is a **single-context** repo.

## Before exploring, read these

- **`AGENTS.md`** at the repo root — this repo's primary domain/architecture doc and coding conventions. There is no separate `CONTEXT.md`; `CLAUDE.md` is a symlink to `AGENTS.md`. Also skim `concept.md` (product concept + status), `DESIGN.md` (design system), and `docs/ux/PRODUCT_UX_BIBLE.md` (UX placement) when the work touches product concept, visual design, or UX.
- **`decisions/`** — architectural decision records live here as `decisions/NNN-slug.md` (sequential numbering), NOT under `docs/adr/`. Read the ones that touch the area you're about to work in.

If a referenced file doesn't exist, **proceed silently** — don't flag its absence or suggest creating it upfront. The `/domain-modeling` skill creates domain docs lazily when terms or decisions actually get resolved. New decision records follow the existing `decisions/NNN-slug.md` convention with the required sections (Context / Investigation / Decision / Risks / Alternatives).

## File structure (single-context)

```
/
├── AGENTS.md            ← primary domain + conventions doc (CLAUDE.md → symlink)
├── concept.md           ← product concept + implementation status
├── DESIGN.md            ← design system
├── docs/ux/             ← UX manifest (PRODUCT_UX_BIBLE.md, ux-architecture.yaml)
├── decisions/           ← ADRs: NNN-slug.md
└── src/
```

## Use the project's vocabulary

When your output names a domain concept (a task title, a refactor proposal, a hypothesis, a test name), use the terms as they appear in `AGENTS.md` and the existing code (e.g. "worktree", "task", "project", "surface", "design token", "push message"). Don't drift to synonyms the project doesn't use.

If the concept you need isn't documented yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision-record conflicts

If your output contradicts an existing decision record, surface it explicitly rather than silently overriding:

> _Contradicts decisions/105 (pin tmux 3.6) — but worth reopening because…_
