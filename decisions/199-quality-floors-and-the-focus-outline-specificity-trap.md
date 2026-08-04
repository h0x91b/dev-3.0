# 199 — Quality floors in the UX bible, and the `focus:outline-none` specificity trap

## Context

`docs/ux/PRODUCT_UX_BIBLE.md` documented *where* features go — surfaces, budgets, placement,
narrow-viewport doctrine — and never *how good* a surface has to be. There was no accessibility
floor, no contrast floor, no typography, copy or motion rules. An audit against the `better-*`
design skill family found that this single hole had already let real defects ship, and that in two
places the docs asserted something false about the code.

## Investigation

The most expensive one was a CSS specificity trap. `index.css` carries one global focus affordance:

```css
:focus-visible { outline: 2px solid rgb(var(--accent)); }   /* (0,1,0) */
```

`UX_DECISIONS.md` (2026-06-27) and the comment above that rule both claimed components therefore
need no focus styling, because the block is authored after `@tailwind utilities` and wins on source
order. That reasoning holds only for the bare `.outline-none` utility, which is also `(0,1,0)`.
Tailwind compiles the **variant** to a class plus a pseudo-class:

```css
.focus\:outline-none:focus { outline: 2px solid #0000; }    /* (0,2,0) */
```

`(0,2,0)` beats `(0,1,0)` regardless of source order, and `:focus` matches whenever `:focus-visible`
does — so on all 27 controls using the variant, keyboard focus painted a *transparent* outline over
the ring. Confirmed by grepping the built `dist/assets/*.css`, not by reasoning alone. One of them,
`ClosePanePicker`, is a full-pane invisible button with no other affordance.

Two audit findings turned out to be **product decisions, not defects**, and were reverted after
review. The browser-remote viewport caps pinch-zoom (`user-scalable=no, maximum-scale=1`) because
the surface underneath is a live terminal that owns touch; pinch fights the pane geometry instead
of magnifying, so reflow at 320px is the accessibility path here, not scaling. And the icon
families loop while hovered on purpose — the loop is the personality of the surface, not an
oversight. Both are now written into §9a as deliberate, with the zoom cap locked by a test, so a
future sweep does not "fix" them again.

## Decision

1. **`docs/ux/PRODUCT_UX_BIBLE.md` §9a "Quality floors"** — six subsections (accessibility,
   contrast, typography, copy, motion, layout grammar) stating the threshold every surface must
   clear regardless of feature. Machine-checkable parts mirrored into `ux-architecture.yaml`.
2. **`focus:outline-none` is banned**, the 27 uses are removed, and
   `src/mainview/__tests__/focus-visible.test.ts` keeps it out. The bare `outline-none` utility
   stays legal. The false claim in `UX_DECISIONS.md` is corrected in place.
3. **The pinch-zoom cap and the looping hover icons stay**, documented as intentional in §9a.1 and
   §9a.5. `hooks/__tests__/useViewport.test.tsx` asserts the cap is present rather than absent.
4. Each floor ships with the mechanism that makes it the default rather than a convention:
   `useViewportClamp` for anchored overlays, `Tip.settingsSection` for settings deep links, a
   contrast test over the real token pairs, a required `confirmLabel`.

## Risks

- The floors are tagged `Proposed`, so parts of the codebase do not meet them yet. That is
  deliberate — a floor nobody has swept to is still worth writing down — but it means a reviewer
  cannot read §9a as a description of the current state.
- Removing `focus:outline-none` makes the accent ring visible in places that were silently
  suppressing it. That is the point, but it is a visible change on ~21 components.
- The contrast floor changes token values; every surface shifts slightly in both themes.

## Alternatives considered

- **Raise the global rule's specificity** (e.g. `:focus-visible:focus-visible`) instead of removing
  the variant. Rejected: it wins the fight without fixing the misconception, and the next
  `focus:outline-none` would still read as intentional to whoever writes it.
- **Keep the floors in the `ux-principal` skill rather than the repo.** Rejected: the skill lives
  outside the repository, so the rules would not travel with the code or be testable in CI.
- **One decision record per defect.** Rejected: they share one root cause, and the diet in
  `UX_DECISIONS.md` exists to stop exactly that kind of proliferation.
