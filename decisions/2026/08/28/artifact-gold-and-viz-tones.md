# Artifact palette: a brand gold, a categorical viz ramp, and per-panel tones

## Context

Dark-theme artifacts read as black-and-white. The starter shipped exactly one decorative hue — `--dev3-accent` — plus three semantic ones, and the authoring contract told authors to use nothing else. Everything that was not a status or a control therefore rendered as `--dev3-text-primary` (near pure white) on a near-black surface, so a long report collapsed into two colors.

## Investigation

Two causes, and only one of them is taste.

The structural one: an author who wants a second hue has nothing to reach for, so they either leave the panel grey or borrow a status color. The chart theme did exactly that — `registerTheme("dev3")` used `[accent, success, warning, danger, text-secondary]` as its categorical series palette, so a four-slice pie painted slice three yellow and slice four red purely from series order. The demo report's own pie showed "Review" in warning yellow for that reason.

The measured one: `--dev3-text-primary` was `250 252 255`, i.e. effectively pure white, and `--dev3-text-muted` (`82 98 121`, used for every table column heading) sat at 3.01:1 on the card surface — below AA for text.

## Decision

Three token families, kept apart deliberately (`src/assets/artifact-template/app.css`, token blocks at the end of the file):

- semantic — `accent`, `success`, `warning`, `danger`: assert a verdict or an interaction;
- brand — gold, and it ships as **three** tokens. On a white page a gold that passes 4.5:1 as text is brown, which is exactly what the first cut shipped. `--dev3-gold` (oklch 0.815 0.145 80 dark / 0.66 max-chroma 82 light, 3.17:1 on white) is the real metal and is used for fills, rules and markers; `--dev3-gold-ink` is the darker text-safe one; `--dev3-on-gold` is the ink that sits on a gold fill. The artifact eyebrow became a gold **chip** for the same reason — on white the metal only survives as a fill;
- categorical — `--dev3-viz-1` … `--dev3-viz-6`: six hues (258, 300, 338, 80, 175, 42) generated at one lightness with equal chroma-as-percentage-of-max, so no series outshouts its neighbour. They are now the ECharts theme's series palette (`app.js`, `registerDev3ChartTheme`).

On top of that, `tone-1` … `tone-6` / `tone-gold` set `--dev3-tone`, which the KPI top rail, the section heading marker, `.pill.tone`, `.mini-fill` and `.evidence-marker` read with a per-element fallback. That is the sanctioned way for an author to color a panel without writing a color value.

Color also had to reach the page itself, not just its accents. `body::before` paints a fixed three-stop radial wash (accent, viz-2, gold) at `--dev3-wash` strength — 1 in dark, .8 in light — and the page color moved from `body` to `html`, because an opaque body background paints over a `z-index: -1` child and the wash was invisible until that moved. Print drops the wash. A toned `.card` additionally tints its own border and shadow, and the KPI glyph follows the tone.

Neutrals were retuned in the same pass: dark `text-primary` `232 238 250` (15.5:1, was pure white), `text-muted` `115 129 149` (4.56:1, was 3.01:1), surfaces lifted to `17 22 36` / `25 31 48`, border `39 49 64`; light `text-muted` `100 116 139`.

## Risks

The palette is a visual contract every existing artifact re-renders against, because artifacts load `app.css` from the bundle they were published with — old ones keep their old colors, so nothing already published shifts. New reports authored against the previous starter still work: every token that existed still exists, and the tone fallbacks mean an untoned panel keeps its old appearance apart from the heading marker.

The KPI rail and the heading marker appear with no opt-in. That is deliberate — the complaint was that a default report has no color — but it does mean an author cannot get the old completely-neutral card back without overriding `--dev3-tone`.

Light-mode `--dev3-gold-ink` still reads brown, which is unavoidable for text at 4.5:1 on white. The fix was to stop using gold as text where it matters — the eyebrow is a chip now — not to brighten the ink past its contrast floor.

The wash depends on nothing painting an opaque background on `body`. A report that sets one hides it silently, with no error.

## Alternatives considered

Tinting the existing accent more widely: cheapest, but with one hue available it turns the report blue-and-dark rather than colorful, and it spends the interaction color on decoration.

Auto-assigning a hue per section by index: maximum color for zero author effort, rejected as confetti — a hue that means nothing still reads as if it means something.

Keeping the semantic tokens as the chart palette and simply adding gold: leaves the actual defect in place, since the misleading colors are the ones charts hand out by default.
