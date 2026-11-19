/** Beige theme neutrals at a user-chosen depth: 0 = lightest paper, 1 = light brown.
 *  Shared so the app surfaces (renderer) and the tmux palette (bun) always match. */
type RGB = readonly [number, number, number];

const STOPS = {
	"surface-base": [[250, 249, 245], [206, 190, 162]],
	"surface-raised": [[253, 252, 250], [218, 204, 179]],
	"surface-raised-hover": [[245, 243, 238], [196, 179, 150]],
	"surface-elevated": [[255, 255, 255], [228, 216, 194]],
	"surface-elevated-hover": [[248, 246, 242], [214, 200, 174]],
	"surface-overlay": [[255, 255, 255], [233, 222, 202]],
	"surface-overlay-hover": [[245, 243, 238], [214, 200, 174]],
	"border-default": [[222, 218, 209], [172, 154, 124]],
	"border-active": [[188, 183, 172], [142, 124, 96]],
	// Quiet text and the accent darken with the paper so they keep their contrast.
	"text-tertiary": [[110, 107, 100], [82, 74, 62]],
	"text-muted": [[148, 145, 138], [104, 94, 78]],
	"accent": [[166, 77, 18], [128, 56, 10]],
	"accent-hover": [[140, 63, 13], [106, 46, 8]],
	"accent-emphasis": [[120, 54, 11], [92, 40, 6]],
	// The page canvas sits a step darker than its cards, as in Light; glass is the frosted veil's tint.
	"bg-grad-from": [[246, 244, 238], [206, 190, 162]],
	"bg-grad-mid": [[241, 238, 230], [198, 181, 151]],
	"bg-grad-to": [[232, 228, 218], [186, 168, 137]],
	"glass": [[255, 255, 255], [238, 229, 211]],
	"tmux-bg": [[252, 251, 248], [218, 204, 179]],
	"tmux-mantle": [[243, 241, 235], [200, 183, 154]],
	"tmux-crust": [[235, 232, 224], [188, 170, 140]],
	"tmux-surface-0": [[225, 221, 211], [180, 162, 132]],
	"tmux-surface-1": [[208, 203, 192], [162, 144, 114]],
	"tmux-surface-2": [[186, 181, 170], [140, 122, 94]],
	"tmux-overlay-0": [[157, 153, 143], [120, 106, 84]],
	"tmux-overlay-1": [[141, 137, 127], [100, 88, 70]],
	"tmux-overlay-2": [[125, 121, 111], [88, 77, 60]],
	"tmux-subtext-0": [[92, 88, 80], [64, 56, 44]],
	"tmux-subtext-1": [[107, 103, 95], [74, 66, 52]],
} satisfies Record<string, readonly [RGB, RGB]>;

export type BeigeToken = keyof typeof STOPS;


/** depth: 0 = lightest paper … 1 = light brown. warmth: 0 = neutral grey, 0.5 = the
 *  designed palette, 1 = warmer. Warmth scales chroma around each colour's own grey,
 *  so lightness (and contrast) stays put; the accent is never desaturated. */
export interface BeigeTone {
	depth: number;
	warmth: number;
}

export const DEFAULT_BEIGE_TONE: BeigeTone = { depth: 0.15, warmth: 0.5 };

function clampUnit(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export function clampBeigeTone(tone: Partial<Record<keyof BeigeTone, unknown>> | undefined): BeigeTone {
	return {
		depth: clampUnit(tone?.depth, DEFAULT_BEIGE_TONE.depth),
		warmth: clampUnit(tone?.warmth, DEFAULT_BEIGE_TONE.warmth),
	};
}

/** Chroma multiplier: 0 at neutral, 1 at the midpoint, 1.6 at the warm end. */
function chromaScale(warmth: number): number {
	return warmth <= 0.5 ? warmth * 2 : 1 + (warmth - 0.5) * 1.2;
}

export function beigeColor(token: BeigeToken, tone: BeigeTone): RGB {
	const [from, to] = STOPS[token];
	const { depth, warmth } = clampBeigeTone(tone);
	const mixed = [0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * depth);
	if (token.startsWith("accent")) return mixed.map(Math.round) as unknown as RGB;
	const grey = 0.299 * mixed[0] + 0.587 * mixed[1] + 0.114 * mixed[2];
	const k = chromaScale(warmth);
	return mixed.map((c) => Math.round(Math.min(255, Math.max(0, grey + (c - grey) * k)))) as unknown as RGB;
}

export function beigeHex(token: BeigeToken, tone: BeigeTone): string {
	return `#${beigeColor(token, tone).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** `depth:warmth`, the form carried on `<html data-beige-tone>` for observers. */
export function formatBeigeTone(tone: BeigeTone): string {
	return `${tone.depth}:${tone.warmth}`;
}

export function parseBeigeTone(value: string | undefined): BeigeTone {
	const [depth, warmth] = (value ?? "").split(":");
	return clampBeigeTone({ depth, warmth });
}

const GLASS_VARS = ["--glass-column-rgb", "--glass-card-rgb", "--glass-header-rgb"];

/** Every CSS custom property the tone drives, as declarations. Triplet tokens stay
 *  `R G B` (used as `rgb(var(--x) / a)`); the gradient stops are hex, as in index.css. */
export function beigeCssDeclarations(tone: BeigeTone): string {
	const out: string[] = [];
	for (const token of Object.keys(STOPS) as BeigeToken[]) {
		if (token.startsWith("tmux-")) continue;
		if (token === "glass") {
			const rgb = beigeColor(token, tone).join(" ");
			for (const name of GLASS_VARS) out.push(`${name}: ${rgb};`);
		} else if (token.startsWith("bg-grad")) {
			out.push(`--${token}: ${beigeHex(token, tone)};`);
		} else {
			out.push(`--${token}: ${beigeColor(token, tone).join(" ")};`);
		}
	}
	return out.join(" ");
}
