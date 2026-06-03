# UX Manifest Changelog

## 2026-05-29 — Initial creation

Created the first Product UX Bible for dev-3.0 from a full repository audit.

Added:
- `PRODUCT_UX_BIBLE.md` — human-readable UX architecture (object model, navigation, surfaces, action taxonomy, token policy, budgets, placement rules, anti-patterns).
- `ux-architecture.yaml` — machine-readable policy (objects, surfaces, action_types, design_tokens, complexity_budgets, placement_rules, anti_patterns, open_questions).
- `UX_DECISIONS.md` — initial UX decisions.
- `UX_AUDIT_REPORT.md` — audit findings, evidence coverage, risks.
- `UX_GLOSSARY.md` — shared UX vocabulary for dev-3.0.

Evidence base: `src/mainview/state.ts`, `src/shared/types.ts`, `src/bun/application-menu.ts`, `src/mainview/components/*`, `src/mainview/index.css`, `concept.md`, `AGENTS.md`.

Confidence: medium. Key inferred area: complexity budgets (derived from changelog history + component sizes, not from an explicit spec).

## 2026-06-03 — Prevent-sleep header toggle + `--awake` token

Documented the new global-header prevent-sleep toggle (`global_header.allowed`) and added the `awake` semantic token (amber, both themes) to the bible token table and `ux-architecture.yaml`. Added a UX decision and decision record 059.

## 2026-06-03 — TaskInfoPanel 4-bar 2×2 model

Documented the inspector header as a 2×2 quickbar grid (Context / Session-Agent / Git / Runtime), one domain per bar, chrome pinned separately. Added `surfaces.task_info_panel.bar_model` to `ux-architecture.yaml`, a new bible §5.1, a UX decision, and updated the §9 budget + closed the related open question. Implemented the matching redistribution in `TaskInfoPanel.tsx` (dev-server + scripts moved to row-2-right; label strip truncates with `+k`).
