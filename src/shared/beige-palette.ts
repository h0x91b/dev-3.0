/** Beige theme neutrals at a user-chosen depth: 0 = lightest paper, 1 = darkest tan.
 *  Shared so the app surfaces (renderer) and the tmux palette (bun) always match. */
type RGB = readonly [number, number, number];

const STOPS = {
	"surface-base": [[250, 249, 245], [226, 219, 203]],
	"surface-raised": [[253, 252, 250], [236, 231, 219]],
	"surface-raised-hover": [[245, 243, 238], [218, 210, 193]],
	"surface-elevated": [[255, 255, 255], [245, 241, 233]],
	"surface-elevated-hover": [[248, 246, 242], [232, 226, 213]],
	"surface-overlay": [[255, 255, 255], [248, 245, 239]],
	"surface-overlay-hover": [[245, 243, 238], [232, 226, 213]],
	"border-default": [[222, 218, 209], [190, 181, 162]],
	"border-active": [[188, 183, 172], [158, 148, 128]],
	"text-tertiary": [[110, 107, 100], [92, 87, 78]],
	"text-muted": [[148, 145, 138], [118, 112, 100]],
	"tmux-bg": [[252, 251, 248], [232, 226, 213]],
	"tmux-mantle": [[243, 241, 235], [218, 210, 193]],
	"tmux-crust": [[235, 232, 224], [207, 198, 179]],
	"tmux-surface-0": [[225, 221, 211], [196, 187, 167]],
	"tmux-surface-1": [[208, 203, 192], [180, 170, 150]],
	"tmux-surface-2": [[186, 181, 170], [160, 150, 130]],
} satisfies Record<string, readonly [RGB, RGB]>;

export type BeigeToken = keyof typeof STOPS;

/** CSS custom properties the depth drives; the tmux-* stops are terminal-only. */
export const BEIGE_CSS_TOKENS = (Object.keys(STOPS) as BeigeToken[]).filter((k) => !k.startsWith("tmux-"));

export const DEFAULT_BEIGE_DEPTH = 0.3;

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
