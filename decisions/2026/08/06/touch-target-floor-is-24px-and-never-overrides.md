# The coarse-pointer touch floor is 24px, and it never overrides a component's own size

## Context

On a phone the Kanban board looked broken: the carousel's column dots rendered as
huge grey circles, label chips and priority badges inflated into blobs, and card
content was squeezed into one-letter-per-line columns. Nothing in the board code
asked for that.

## Investigation

The cause was the global touch-target rule in `src/mainview/index.css`:

```css
@media (pointer: coarse) {
  :is(button, a[role="button"], [role="menuitem"], [role="option"], [role="tab"]) {
    min-height: 44px; min-width: 44px;
  }
}
```

Two separate faults. First, 44×44 as a *blanket floor* hits every inline control,
including 6px carousel dots and text chips that are not meant to be standalone
tap targets. Second, `:is()` takes the specificity of its heaviest argument
(`[role="menuitem"]`, 0-1-0) and the rule is authored after `@tailwind utilities`,
so it silently beat every explicit `min-h-11` / `h-9` a component had set — the
settings category rows measured 24px once the floor was lowered, proving the
class had never been the winner on touch.

Reproduced in headless Chromium at 360×780 by injecting the same rule (the tool
cannot emulate `pointer: coarse`), then confirmed the phone screenshot pixel for
pixel; measured heights via `getBoundingClientRect` before and after.

## Decision

- The global coarse-pointer floor is **24×24** (WCAG 2.5.8), written with
  `:where()` so its specificity is 0 and an author's deliberate size always wins.
- **44×44 stays where a row is a real tap target**: `.touch-actions`, now applied
  by `BottomSheet` itself to its content wrapper — sheet rows are the default,
  not opt-in per sheet.
- `MobileBoardCarousel` no longer renders per-column dots; chevrons plus swipe
  are the navigation, and the pager keeps only the position (`5 / 9`) because the
  column header right below it already names the column.

## Risks

Any control that relied on the old blanket 44px and sets no size of its own now
sits at 24px. Sheets and the settings navs are covered; a surface added later
must size its own rows (or wrap them in `.touch-actions`) instead of leaning on
the floor.

## Alternatives considered

- Keep 44px and exempt chips per component — dozens of call sites, and the
  specificity trap would still hide component-set sizes.
- Drop the global rule entirely — loses the WCAG floor for controls that set no
  size at all.
