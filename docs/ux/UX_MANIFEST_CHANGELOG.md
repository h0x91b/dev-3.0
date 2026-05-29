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
