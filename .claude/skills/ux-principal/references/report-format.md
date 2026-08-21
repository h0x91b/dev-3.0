# UX Principal Report format

The report is **conversation output only** — never persist it as a file in the repo.
It flows into the PR description; git history preserves it.

## Lite report (default — manifest-compliant features)

Use this when the Architecture-change gate did NOT pass. Keep it under ~30 lines.

```md
# UX plan: <feature>

Manifest: compliant, no updates. Complies with: <bible §, yaml rule ids>

## Placement
- Surface / entry point / visibility rule: ...
- Rejected: <one line, only if a wrong placement is tempting>

## Action hierarchy
| Element | Label | Semantic role | Existing token class | Visibility |
|---|---|---|---|---|

## Interaction contract
- Trigger / states (loading, empty, error, success) / keyboard & focus / responsive: ...

## Implementation brief
1. ...
Do not implement: ...
```

## Full report (architecture-changing features only)

```md
# UX Principal Report: <feature>

Date: YYYY-MM-DD
Mode: planning only
Manifest status: current | updated | bootstrapped | missing evidence
Confidence: high | medium | low

## 1. Feature understanding

- User job:
- Owning object or workflow:
- Feature class:
- Scope:
- Frequency:
- Risk:
- Discoverability need:
- Assumptions:

## 2. UX placement decision

Recommended placement:

- Route/screen:
- Surface:
- Menu/nav group:
- Entry point:
- Visibility rule:

Rejected placements:

- ...

Rationale:

- ...

Evidence:

- `path/to/file.tsx`

## 3. Navigation and menu changes

- Add:
- Rename:
- Move:
- Remove:
- No change:

## 4. Action hierarchy

| Element | Label | Semantic role | Existing token class | Visibility | Notes |
|---|---|---|---|---|---|
| Primary CTA | ... | primary | ... | persistent | ... |
| Secondary action | ... | secondary | ... | persistent/overflow | ... |
| Destructive action | ... | destructive | ... | overflow/confirm | ... |

## 5. Layout and component plan

- Screen pattern:
- Components to reuse:
- New components allowed:
- Components not allowed:
- Data density:
- Progressive disclosure:

## 6. Interaction contract

- Trigger:
- Preconditions:
- Default state:
- Loading state:
- Empty state:
- Error state:
- Permission-denied state:
- Success state:
- Confirmation/undo:
- Keyboard and focus:
- Responsive behavior:

## 7. Handed to the craft skills

One line each, naming the skill that owns the follow-up. Do not write their rules out here.

- Accessibility (`better-accessibility`):
- Copy and labels (`better-writing`):
- Colour or token gap (`better-colors`):
- Motion or polish (`better-ui`):

## 8. Manifest updates

Files updated (bible/yaml hold the rule; decisions log holds the compact why):

- `docs/ux/PRODUCT_UX_BIBLE.md`:
- `docs/ux/ux-architecture.yaml`:
- `docs/ux/UX_DECISIONS.md`: one compact entry (≤5 lines)

## 9. Implementation brief for coding agent

Implement exactly this:

1. ...

Do not implement:

- ...

Likely files to inspect or modify:

- `...`

Acceptance criteria:

- ...
```
