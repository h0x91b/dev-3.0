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

/** CSS custom properties the depth drives; the tmux-* stops are terminal-only. */
export const BEIGE_CSS_TOKENS = (Object.keys(STOPS) as BeigeToken[]).filter((k) => !k.startsWith("tmux-"));

export const DEFAULT_BEIGE_DEPTH = 0.15;

export function clampBeigeDepth(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_BEIGE_DEPTH;
}

export function beigeColor(token: BeigeToken, depth: number): RGB {
	const [from, to] = STOPS[token];
	const d = clampBeigeDepth(depth);
	return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * d)) as unknown as RGB;
}

export function beigeHex(token: BeigeToken, depth: number): string {
	return `#${beigeColor(token, depth).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
