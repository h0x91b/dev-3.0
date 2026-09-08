/**
 * The two scene palettes, dark and light.
 *
 * **Why hex here and not design tokens.** A token is a CSS custom property; a
 * WebGL uniform is three floats. There is no way for a shader to resolve
 * `var(--bg-raised)`, and reading every material back through
 * `getComputedStyle` per frame would cost a layout flush per draw. So the scene
 * carries its own literals — the same carve-out `STATUS_COLORS` already has in
 * `shared/types.ts`, and for the same reason: these are values for inline/GPU
 * consumption, not theme chrome.
 *
 * What is NOT carved out is theming itself. Both palettes are complete and the
 * light one is a real light scene — a paler ground, a higher ambient floor so no
 * face reads as a hole, and darker ink on the deck decals. The reference demo
 * had one dark palette plus a light CSS override, which is why its light theme
 * left the deck labels white-on-white; that bug is the reason this file exists
 * (`decisions/2026/09/08/strata-carries-only-recorded-facts.md`).
 *
 * Status colours never appear here. They come from `useStatusColors()` so the
 * stage agrees with every board, badge and column header in the app.
 */

import type { StrataPalette } from "./strata-gl";
import type { StrataMaterials } from "./strata-scene";

export const DARK_PALETTE: StrataPalette = {
	fog: "#090f19",
	ambient: 0.29,
	decalTitle: "#b2c2d5",
	decalSub: "#718397",
	decalAlpha: 0.6,
};

export const LIGHT_PALETTE: StrataPalette = {
	fog: "#dbe3ec",
	// Higher than dark: with a pale ground, an unlit face at 0.29 reads as a hole
	// punched in the deck rather than as shadow.
	ambient: 0.62,
	decalTitle: "#3c5570",
	decalSub: "#5d7590",
	decalAlpha: 0.72,
};

export const DARK_MATERIALS: StrataMaterials = {
	gridMinor: "#121e2d",
	gridMajor: "#1c2b3d",
	substrateFleck: "#34475c",
	substrateRing: "#35465a",
	deckSkirt: "#172636",
	deckRim: "#304252",
	deckShadow: "#121f2e",
	deckBody: "#2b3947",
	deckTop: "#243340",
	deckInlay: "#455563",
	deckRail: "#344351",
	deckFoot: "#627078",
	shell: "#b4c0c8",
	shellDone: "#a9bbb9",
	shellQuiet: "#53626e",
	panelDark: "#253847",
	panelBlack: "#142633",
	glass: "#7095a2",
	mastPipe: "#8598a6",
	route: {
		delivered: "#638993",
		held: "#d9b77c",
		queued: "#a99bc7",
		failed: "#f19b7f",
	},
	routeMuted: "#293a49",
	holdPlate: "#3c4a53",
	holdRing: "#dfb781",
	unknown: "#7b8b9c",
};

export const LIGHT_MATERIALS: StrataMaterials = {
	gridMinor: "#cbd6e2",
	gridMajor: "#b3c2d2",
	substrateFleck: "#9fb0c2",
	substrateRing: "#a9b8c8",
	deckSkirt: "#c3cfdb",
	deckRim: "#93a5b7",
	deckShadow: "#aab8c6",
	deckBody: "#d5dee7",
	deckTop: "#e2e9f0",
	deckInlay: "#8fa1b3",
	deckRail: "#b8c5d2",
	deckFoot: "#7d8fa2",
	shell: "#f2f5f8",
	shellDone: "#e3ebe8",
	shellQuiet: "#c0cbd6",
	panelDark: "#8497aa",
	panelBlack: "#6d8093",
	glass: "#a8c4cd",
	mastPipe: "#9fb1c0",
	route: {
		delivered: "#4a7b86",
		held: "#a97c31",
		queued: "#7a68a6",
		failed: "#c2532f",
	},
	routeMuted: "#b9c6d3",
	holdPlate: "#9dabb7",
	holdRing: "#a97c31",
	unknown: "#8496a8",
};

export function strataPalette(theme: "light" | "dark"): {
	palette: StrataPalette;
	materials: StrataMaterials;
} {
	return theme === "light"
		? { palette: LIGHT_PALETTE, materials: LIGHT_MATERIALS }
		: { palette: DARK_PALETTE, materials: DARK_MATERIALS };
}
