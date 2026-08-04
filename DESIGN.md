# DESIGN.md — dev-3.0

Native desktop project manager for AI agents. Kanban board with glass morphism, git worktree isolation, and an embedded GPU-accelerated terminal.

Two themes: **dark** (default) and **light**, toggled via `data-theme` attribute on `<html>`. System preference is respected.

---

## 1. Visual Theme & Atmosphere

**Dark theme** — deep space-navy backgrounds with frosted glass surfaces. High contrast text on near-black. Kanban columns glow softly with their status color. The feel is focused, immersive, developer-oriented. Density is moderate — enough whitespace to breathe but no wasted space.

**Light theme** — the same concept mirrored, not a bleached copy. Nothing is pure
white and nothing is pure black: every surface carries a little chroma so it reads
as tinted paper, and contrast is deliberately short of the maximum. The colour
intensity is calibrated by eye between "bleached" and "too much". Status colours
go deep and fully saturated instead of pastel, because the glass veil eats most of
their chroma on the way to the screen.

Glass morphism is the defining visual pattern — every kanban column and card uses backdrop blur with semi-transparent backgrounds. This creates layered depth without heavy shadows.

---

## 2. Color Palette & Roles

Both palettes are authored in **OKLCH** and shipped as sRGB triplets. Three rules
hold the system together:

1. **One hue per family.** Surfaces sit on 268° in both themes, text on 262°.
   No hue drift up or down a ramp.
2. **The lightness ramp is monotonic**, so a hover never lands darker than the
   surface it lifts from, and `--surface-overlay` sits *above* `--surface-elevated`.
3. **The text ladder is spaced by measured contrast** (APCA), not by eye —
   roughly `Lc 100 / 78 / 62 / 45` from primary to muted, in both themes.

### Surfaces

| Role | CSS Variable | Dark | Light |
|------|-------------|------|-------|
| Base background | `--surface-base` | `rgb(6, 9, 22)` | `rgb(235, 239, 250)` |
| Raised surface | `--surface-raised` | `rgb(14, 19, 33)` | `rgb(243, 246, 252)` |
| Raised hover | `--surface-raised-hover` | `rgb(19, 25, 41)` | `rgb(237, 241, 251)` |
| Elevated surface | `--surface-elevated` | `rgb(21, 27, 43)` | `rgb(249, 251, 254)` |
| Elevated hover | `--surface-elevated-hover` | `rgb(29, 36, 53)` | `rgb(243, 246, 252)` |
| Overlay (modals) | `--surface-overlay` | `rgb(27, 33, 48)` | `rgb(252, 253, 255)` |

### Text

`Lc` is the APCA contrast against a kanban card — the worst-case reading surface.
`Lc 75` is the floor for body text, `Lc 60` for everything else; muted is for
decoration and disabled state only, never for text that has to be read.

| Role | CSS Variable | Dark | Light | Lc dark / light |
|------|-------------|------|-------|-----------------|
| Primary | `--text-primary` | `rgb(239, 244, 252)` | `rgb(17, 26, 47)` | 99 / 93 |
| Secondary | `--text-secondary` | `rgb(200, 211, 231)` | `rgb(68, 81, 103)` | 78 / 76 |
| Tertiary | `--text-tertiary` | `rgb(170, 182, 204)` | `rgb(99, 113, 136)` | 61 / 63 |
| Muted | `--text-muted` | `rgb(132, 145, 169)` | `rgb(134, 148, 173)` | 41 / 46 — decoration and disabled state only; does not clear the text floors |

### Borders

| Role | CSS Variable | Dark | Light |
|------|-------------|------|-------|
| Default | `--border-default` | `rgb(75, 84, 108)` | `rgb(183, 191, 207)` |
| Active | `--border-active` | `rgb(95, 107, 135)` | `rgb(150, 163, 185)` |

### Semantic / Interactive

`--accent-hover` is for accent **fills** — it deepens in both themes so white ink
on the button stays readable. `--accent-emphasis` is for accent **text and icons**
on hover — it lifts on dark and deepens on light, so a link always gains contrast
when you point at it. Never swap the two.

| Role | CSS Variable | Dark | Light |
|------|-------------|------|-------|
| Accent (primary action) | `--accent` | `#4596fe` | `#0c75e6` |
| Accent hover (fills) | `--accent-hover` | `#1c77f1` | `#085dc7` |
| Accent emphasis (text hover) | `--accent-emphasis` | `#89beff` | `#0554b5` |
| Danger | `--danger` | `#ff8987` | `#d61133` |
| Success | `--success` | `#3fdf7e` | `#0e8a47` |
| Success hover (fills) | `--success-hover` | `#04be58` | `#0a7239` |
| Warning | `--warning` | `#f0d24e` | `#91760d` |
| Favorite (saved star) | `--favorite` | `#f9b63d` | `#a2710f` |
| Awake | `--awake` | `#f49456` | `#bd5e0f` |
| Achievement gold | `--stat-gold` | `#e5aa41` | `#9d6e0c` |
| On fire | `--stat-fire` | `#fb6d2c` | `#c24a0b` |

The four warm roles are separated by **hue**, not just lightness, so they never
read as one colour: warning 96° → gold 78° → awake 52° → fire 42°.

### Background Gradient

The app background is a subtle three-stop gradient, not a flat color. Hue travels
in one direction across the three stops; the light theme's mid stop used to be
olive and fought both ends.

| Property | Dark | Light |
|----------|------|-------|
| Angle | `115deg` | `135deg` |
| From | `#060916` | `#d3dfef` |
| Mid | `#0f1731` | `#e0def1` |
| To | `#180d29` | `#b6b2cb` |

### Task Status Colors (Kanban)

Each kanban column has a unique color. Dark uses bright/pastel tones; light uses
deep, fully saturated tones — a colour laid over near-white glass at 31% alpha
keeps only a fraction of its chroma, so anything softer makes eight columns look
like eight shades of white. Light hues are spaced 15° → 40° → 95° → 152° → 232° →
272° → 318°, measured so no two rendered columns land closer than 0.045 in OKLCH.

`STATUS_COLORS` / `STATUS_COLORS_LIGHT` are for **glow, dot, and border identity** (fill and decoration uses). When a status colour is rendered as **text** in light theme — e.g. the task-count badge chip — use `STATUS_COLORS_LIGHT_INK` instead; these are darkened variants that clear APCA |Lc| ≥ 60 on the glass column header. In dark theme the pastel `STATUS_COLORS` serve as text directly.

| Status | Dark | Light |
|--------|------|-------|
| Todo | `#70e3ff` (cyan) | `#0182b0` (dark cyan) |
| In Progress | `#afbaff` (periwinkle) | `#4b59ff` (indigo) |
| User Questions | `#ffa353` (coral orange) | `#d04801` (dark orange) |
| Review by AI | `#a0aec0` (cool gray) | `#656971` (slate — deliberately the neutral one) |
| Review by User | `#ffe55f` (golden yellow) | `#9e8401` (deep gold) |
| Review by Colleague | `#c4a5ff` (light violet) | `#b702df` (magenta) |
| Completed | `#3cf3b0` (mint green) | `#04944b` (emerald) |
| Cancelled | `#ff8282` (red) | `#d20346` (crimson) |

### Label Colors (12-color palette)

Distributed ~30° apart on the color wheel for maximum perceptual distance. Same in both themes.

```
#ef4444  red        #14b8a6  teal       #f97316  orange
#8b5cf6  violet     #84cc16  lime       #ec4899  pink
#06b6d4  cyan       #eab308  yellow     #3b82f6  blue
#22c55e  green      #f43f5e  rose       #6366f1  indigo
```

---

## 3. Typography Rules

| Role | Font | Tailwind rung | Size | Weight | Notes |
|------|------|---------------|------|--------|-------|
| Dense chrome (px-pinned) | System default | `text-dense` | 10px | 500 | Badges, counters; immune to mobile-dense-factor scaling |
| Compact meta | System default | `text-micro` | 11px | 400–500 | Dense labels, chips |
| Small text | System default | `text-xs` | 12px | 400 | Secondary info, metadata |
| Body text | System default | `text-sm` | 14px | 400 | Primary UI text |
| Base | System default | `text-base` | 16px | 400 | Default prose |
| Section headings | System default | `text-lg` | 18px | 600 | Panel/section headers |
| Screen title (h1) | System default | `text-2xl` | 24px | 600–700 | Peer screen titles (Changelog, Stats, Settings) |
| Code / Terminal | JetBrainsMono Nerd Font Mono | — | 14px | 400/700 | Monospace for code, branches, CLI output |

**Fallback stack (mono):** `'JetBrainsMono Nerd Font Mono', 'SF Mono', Menlo, monospace`

**Principles:**
- Font smoothing: `antialiased` globally on all elements
- No custom body font — system defaults for native feel (Electrobun app)
- Monospace is reserved for technical content: branch names, terminal, code snippets
- Weight `font-medium` (500) for interactive elements, `font-semibold` (600) for emphasis

---

## 4. Component Stylings

### Buttons

**Primary (accent):**
```
px-4 py-3 | bg-accent text-white | text-sm font-semibold
rounded-xl | hover:bg-accent-hover | transition-colors
```

**Secondary (elevated):**
```
px-3 py-1.5 | bg-elevated text-fg | text-sm
rounded-lg | transition-colors
```

**Ghost:**
```
px-4 py-1.5 | text-fg-3 text-sm
hover:text-fg | rounded-lg | transition-colors
```

### Cards / Containers

**Raised card:** `bg-raised rounded-2xl border border-edge`
**Elevated panel:** `bg-elevated rounded-xl border border-edge`
**Modal overlay:** `bg-overlay border border-edge rounded-2xl shadow-2xl p-6`
**Modal width:** `w-[32.5rem]` (520px)

### Form Inputs

```
w-full px-3 py-2.5 | bg-elevated border border-edge rounded-xl
text-fg placeholder-fg-muted | outline-none
focus:border-accent/50 | transition-colors
```

### Focus ring (keyboard)

Focus affordance is global, not per-component. `index.css` defines a single
`:focus-visible` ring (`outline: 2px solid rgb(var(--accent)); outline-offset: 2px`)
that shows **only** for keyboard / assistive-tech focus — never on a mouse click.

- Do **not** add per-element focus styling for keyboard users; the global rule
  covers every focusable control (buttons, the custom `Select` trigger, inputs,
  links, `tabindex` elements). Keep using `outline-none` to suppress the default
  mouse-focus outline — the global rule overrides it for `:focus-visible`.
- Dialog/modal shells use `tabIndex={-1}` + `role="dialog"` so the focus trap can
  pull focus in on open; they are exempted from the ring (no box around the panel).
- Inputs keep their `focus:border-accent/50` border change in addition to the ring.

### Scrollbars

```css
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-thumb { background: rgb(var(--border-active)); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgb(var(--text-muted)); }
```

---

## 5. Layout Principles

**Base spacing unit:** 4px (Tailwind default)

**Common spacing scale:**

| Token | Value | Usage |
|-------|-------|-------|
| `gap-1` / `p-1` | 4px | Tight grouping (icon + label) |
| `gap-1.5` / `p-1.5` | 6px | Compact lists |
| `gap-2` / `p-2` | 8px | Standard element spacing |
| `gap-3` / `p-3` | 12px | Section padding, card content |
| `gap-4` / `p-4` | 16px | Large spacing |
| `gap-6` / `p-6` | 24px | Modal padding, major sections |

**Key dimensions:**
- Kanban column width: `w-[17.5rem]` (280px)
- Modal width: `w-[32.5rem]` (520px)
- Sidebar width: `w-72` (288px)
- Header padding: `px-5 py-2.5`

**Border-radius scale:**

| Token | Value | Usage |
|-------|-------|-------|
| `rounded` | 4px | Small chips, badges |
| `rounded-lg` | 8px | Buttons, inputs |
| `rounded-xl` | 12px | Cards, task cards |
| `rounded-2xl` | 16px | Columns, modals, major containers |
| `rounded-full` | 50% | Avatars, circular icons |

---

## 6. Depth & Elevation

Four-level surface hierarchy, reinforced by glass morphism rather than heavy shadows.

| Level | Surface | Shadow (Dark) | Shadow (Light) |
|-------|---------|---------------|----------------|
| 0 — Base | `--surface-base` | none | none |
| 1 — Raised | `--surface-raised` | minimal | minimal |
| 2 — Elevated | `--surface-elevated` | medium | medium |
| 3 — Overlay | `--surface-overlay` | `shadow-2xl` | `shadow-2xl` |

**Column shadow:**

| Theme | Value |
|-------|-------|
| Dark | `0 10px 30px -10px rgb(0 0 0 / 0.3)` |
| Light | `0 8px 30px -8px rgb(80 100 140 / 0.13), 0 2px 8px -2px rgb(80 100 140 / 0.06)` |

**Card hover shadow:**

| Theme | Value |
|-------|-------|
| Dark | `0 8px 20px -6px rgb(0 0 0 / 0.25)` |
| Light | `0 8px 24px -6px rgb(80 100 140 / 0.14)` |

---

## 7. Do's and Don'ts

**Do:**
- Use CSS variables for all colors — never hardcode hex in components
- Use the `rgb(var(--name) / alpha)` pattern for transparency
- Apply glass morphism only to kanban columns and cards — not to every surface
- Keep status colors semantic — each status has one assigned color, never reuse
- Use `transition-colors` on all interactive elements

**Don't:**
- Don't use `opacity` for dimming surfaces — use the alpha channel in `rgb()` instead
- Don't add heavy box-shadows on dark theme — glass blur provides depth
- Don't use colored backgrounds for buttons except the primary accent
- Don't mix label colors with status colors — they are separate palettes
- Don't use font weights above 700 — the system font doesn't need it
- Don't override scrollbar styles outside the kanban scroll area

---

## 8. Responsive Behavior

**Breakpoints (Tailwind defaults):**

| Token | Width | Usage |
|-------|-------|-------|
| `sm` | 640px | 2-column grids |
| `md` | 768px | Show/hide hover-only controls |
| `lg` | 1024px | Side-by-side layouts |
| `xl` | 1280px | Wide kanban boards |

**Patterns:**
- `grid gap-3 sm:grid-cols-2` — responsive grid
- `flex flex-col lg:flex-row` — stack on mobile, row on desktop
- `opacity-100 md:opacity-0 md:group-hover:opacity-100` — show on hover (desktop only)

Note: This is primarily a desktop app (Electrobun). Mobile layout is secondary but supported via responsive utilities.

---

## 9. Kanban Glass Morphism

This is the signature visual element of dev-3.0. Every kanban column and card uses frosted glass with dynamic color glow.

### Glass Variables

| Variable | Dark | Light |
|----------|------|-------|
| `--glass-column-rgb` | `12 16 23` | `255 255 255` |
| `--glass-column-alpha` | `0.7` | `0.49` |
| `--glass-card-rgb` | `255 255 255` | `255 255 255` |
| `--glass-card-alpha` | `0.04` | `0.66` |
| `--glass-card-hover-alpha` | `0.09` | `0.81` |
| `--glass-header-rgb` | `12 15 23` | `255 255 255` |
| `--glass-header-alpha` | `0.46` | `0.58` |
| `--glass-blur-column` | `12px` | `18px` |
| `--glass-blur-header` | `16px` | `22px` |

### Glass Border

| Variable | Dark | Light |
|----------|------|-------|
| `--glass-border-rgb` | `255 255 255` | `0 0 0` |
| `--glass-border-column-alpha` | `0.06` | `0.05` |
| `--glass-border-card-alpha` | `0.09` | `0.06` |
| `--glass-border-card-hover-alpha` | `0.17` | `0.13` |

### Column Glow Effect

Each column has a `::before` pseudo-element that creates a color glow using the column's status color (`--col-rgb`, set dynamically via `hexToRgb(statusColor)`).

```css
.column-glow::before {
  background: linear-gradient(
    135deg,
    rgb(var(--col-rgb) / var(--glow-start-alpha)) 0%,
    rgb(var(--col-rgb) / var(--glow-mid-alpha)) 55%,
    transparent 100%
  );
  box-shadow: inset 0 2px 0 0 rgb(var(--col-rgb) / var(--glow-line-alpha));
}
```

| Variable | Dark | Light |
|----------|------|-------|
| `--glow-start-alpha` | `0.17` | `0.31` |
| `--glow-mid-alpha` | `0.04` | `0.1` |
| `--glow-line-alpha` | `0.46` | `0.62` |

**Light theme outer shadow (per column):**
```css
box-shadow: 0 4px 20px -4px rgb(var(--col-rgb) / 0.31),
            0 2px 8px -2px rgb(var(--col-rgb) / 0.16);
```

### Kanban Column Structure

```
.glass-column.column-glow.rounded-2xl.border
├── Header (glass-header, backdrop-blur)
│   ├── Status color dot
│   ├── Column title
│   └── Task count badge
├── Task list (scrollable)
│   ├── .glass-card.rounded-xl.border
│   │   ├── Task title
│   │   ├── Labels (colored badges)
│   │   └── Branch name (mono)
│   └── ...more cards
└── Add task button
```

**Task card bottom accent:** `border-bottom: 2px solid ${statusColor}30` — a subtle tinted line at the bottom of each card.

---

## 10. Agent Prompt Guide

**Quick color reference:**
- Accent/links: `--accent` (blue)
- Success/positive: `--success` (green)
- Danger/destructive: `--danger` (red)
- Warning/caution: `--warning` (yellow)
- Favorite (saved star): `--favorite` (gold)
- Surfaces: base → raised → elevated → overlay (4 levels)

**When generating UI for this project:**
1. Always use Tailwind utility classes with CSS variable references (`bg-raised`, `text-fg`, `border-edge`)
2. Never hardcode colors — always use semantic tokens
3. Glass morphism is for kanban board only — other UI uses solid surfaces
4. Both themes must work — test dark and light
5. Transitions: `transition-colors` on all interactive elements
6. Border-radius: `rounded-xl` for cards, `rounded-2xl` for containers, `rounded-lg` for buttons/inputs
