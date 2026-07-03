# UX Principal Report format

Use this format for the final response and for `docs/ux/feature-plans/<feature>.md`.

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

## 4. Action hierarchy and token decisions

| Element | Label | Semantic role | Concrete variant/token | Visibility | Notes |
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

## 7. Accessibility requirements

- Accessible names:
- Focus management:
- Keyboard support:
- ARIA or semantic HTML:
- Contrast and token notes:
- Motion notes:

## 8. Manifest updates

Files updated or to update:

- `docs/ux/ux-architecture.yaml`:
- `docs/ux/UX_DECISIONS.md`:
- `docs/ux/UX_MANIFEST_CHANGELOG.md`:

Summary of changes:

- ...

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
