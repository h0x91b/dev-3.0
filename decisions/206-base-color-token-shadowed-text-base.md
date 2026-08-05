# 206 — `base` colour token shadowed Tailwind's `text-base`, painting 107 icons invisible

## Context

`tailwind.config.js` registered `colors.base = rgb(var(--surface-base))`. Tailwind derives
every colour plugin from `theme.colors`, so it emitted `.text-base { color: var(--surface-base) }`
**in addition to** its built-in `.text-base { font-size: 1rem }`. Same class name, two
properties, both applied.

Every element written as `className="text-base leading-none"` — the house idiom for a Nerd Font
icon glyph, expecting to inherit colour from its parent button — therefore got
`color: --surface-base`: the page background, painted on `--surface-raised`. Contrast 1.06:1.

## Investigation

Measured in a real browser rather than inferred. `getComputedStyle` on the icon `<span>`
returned `rgb(6, 9, 22)` against a `rgb(14, 19, 33)` parent, and the two `.text-base` rules were
both present in the live stylesheet. A DOM sweep for `color === rgb(6, 9, 22)` found **107**
affected elements on the Dashboard alone.

The trap is that the *button* usually carries a correct `text-fg-3`, so inspecting the button
(or the class strings) shows nothing wrong — the child span's own colour rule wins over
inheritance. Sites written as `text-fg text-base` were unaffected, because `.text-fg` is emitted
after `.text-base` in the colour block; only colour-by-inheritance sites broke.

## Decision

`base` is out of `theme.extend.colors`. The surface is registered only where it is used:
`extend.backgroundColor.base` (124 `bg-base` call sites) and `extend.ringColor.base` (one
`ring-base`). `.text-base` is now unambiguously the font-size rung.

The single deliberate use of `text-base` as a colour — the knocked-out check mark on the diff
viewer's solid `bg-success` "Read" checkbox — moved to a new, non-colliding token
`colors["base-ink"]`, same value, no visual change.

`src/mainview/__tests__/tailwind-token-collisions.test.ts` fails the build if any colour token
name ever shadows a font-size rung again (project rungs plus Tailwind's own defaults).

## Risks

Any future code that writes `text-base` expecting the background colour now gets the font size
and inherits its parent's colour. That is the intended reading of the class; `text-base-ink` is
the explicit token for the other intent, and the guard test documents the rule.

## Alternatives considered

- **Rewrite all 64 `text-base` call sites to `text-[1rem]`** — churn, and it leaves the landmine
  armed for the next person who types `text-base`.
- **Rename the surface token to `surface`** — touches 124 `bg-base` call sites for no benefit
  over scoping the token to the plugins that need it.
- **Per-site workaround** (what `TaskDialogSubjectCard.tsx` already did with a comment) — the
  status quo that let this reach 107 broken elements.
