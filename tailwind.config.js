/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/mainview/**/*.{html,js,ts,jsx,tsx}"],
	theme: {
		extend: {
			// Closed type scale — arbitrary text-[…] sizes are banned (they carry
			// no line-height and defeat mobile-dense-factor px-pinning).
			// px-pinned rungs (nano, dense) are immune to MOBILE_DENSE_FACTOR
			// root-font scaling, mirroring the 44px touch-target pattern in index.css.
			fontSize: {
				// ── sub-floor (px-pinned, decorative only) ──────────────────
				nano:      ["9px",       { lineHeight: "1.4" }], // purely decorative; carries meaning → use dense
				dense:     ["10px",      { lineHeight: "1.4" }], // dense chrome floor, px-pinned
				// ── rem-based rungs (scale with root font) ──────────────────
				micro:     ["0.6875rem", { lineHeight: "1.4" }], // 11px – compact meta
				// text-xs  0.75rem  12px  (Tailwind default)
				"sm-plus": ["0.8125rem", { lineHeight: "1.5" }], // 13px – between xs and sm
				// text-sm  0.875rem 14px  (Tailwind default)
				"base-sm": ["0.95rem",   { lineHeight: "1.5" }], // 15px – between sm and base
				// text-base 1rem   16px  (Tailwind default)
				"base-lg": ["1.0625rem", { lineHeight: "1.5" }], // 17px – between base and lg
				// text-lg  1.125rem 18px  (Tailwind default)
				// text-xl  1.25rem  20px  (Tailwind default)
				"xl-sm":   ["1.375rem",  { lineHeight: "1.3" }], // 22px – between xl and 2xl
				// text-2xl 1.5rem   24px  (Tailwind default)
			},
			fontFamily: {
				mono: [
					"'JetBrainsMono Nerd Font Mono'",
					"'SF Mono'",
					"Menlo",
					"monospace",
				],
			},
			// `base` is deliberately NOT in `colors`: that would also emit a
			// `.text-base` COLOR utility, which collides with Tailwind's built-in
			// `text-base` FONT-SIZE utility and silently paints icons and headings
			// in the page background colour. Register the surface only where it is
			// actually used. Never move `base` back into `colors`.
			backgroundColor: { base: "rgb(var(--surface-base) / <alpha-value>)" },
			ringColor: { base: "rgb(var(--surface-base) / <alpha-value>)" },
			colors: {
				// Knocked-out ink for text sitting on a solid accent/success fill —
				// the base surface colour under a name that cannot collide with the
				// `text-base` font-size rung.
				"base-ink": "rgb(var(--surface-base) / <alpha-value>)",
				raised: "rgb(var(--surface-raised) / <alpha-value>)",
				"raised-hover": "rgb(var(--surface-raised-hover) / <alpha-value>)",
				elevated: "rgb(var(--surface-elevated) / <alpha-value>)",
				"elevated-hover": "rgb(var(--surface-elevated-hover) / <alpha-value>)",
				overlay: "rgb(var(--surface-overlay) / <alpha-value>)",
				fg: "rgb(var(--text-primary) / <alpha-value>)",
				"fg-2": "rgb(var(--text-secondary) / <alpha-value>)",
				"fg-3": "rgb(var(--text-tertiary) / <alpha-value>)",
				"fg-muted": "rgb(var(--text-muted) / <alpha-value>)",
				edge: "rgb(var(--border-default) / <alpha-value>)",
				"edge-active": "rgb(var(--border-active) / <alpha-value>)",
				accent: {
					DEFAULT: "rgb(var(--accent) / <alpha-value>)",
					hover: "rgb(var(--accent-hover) / <alpha-value>)",
					emphasis: "rgb(var(--accent-emphasis) / <alpha-value>)",
					fill: "rgb(var(--accent-fill) / <alpha-value>)",
					"fill-hover": "rgb(var(--accent-fill-hover) / <alpha-value>)",
				},
				danger: {
					DEFAULT: "rgb(var(--danger) / <alpha-value>)",
					strong: "rgb(var(--danger-strong) / <alpha-value>)",
					fill: "rgb(var(--danger-fill) / <alpha-value>)",
					"fill-hover": "rgb(var(--danger-fill-hover) / <alpha-value>)",
				},
				"danger-strong": "rgb(var(--danger-strong) / <alpha-value>)",
				"success-strong": "rgb(var(--success-strong) / <alpha-value>)",
				warning: {
					DEFAULT: "rgb(var(--warning) / <alpha-value>)",
					strong: "rgb(var(--warning-strong) / <alpha-value>)",
					fill: "rgb(var(--warning-fill) / <alpha-value>)",
					"fill-hover": "rgb(var(--warning-fill-hover) / <alpha-value>)",
				},
				"warning-strong": "rgb(var(--warning-strong) / <alpha-value>)",
				favorite: "rgb(var(--favorite) / <alpha-value>)",
				awake: {
					DEFAULT: "rgb(var(--awake) / <alpha-value>)",
					hover: "rgb(var(--awake-hover) / <alpha-value>)",
				},
				success: {
					DEFAULT: "rgb(var(--success) / <alpha-value>)",
					hover: "rgb(var(--success-hover) / <alpha-value>)",
					fill: "rgb(var(--success-fill) / <alpha-value>)",
					"fill-hover": "rgb(var(--success-fill-hover) / <alpha-value>)",
				},
				hint: {
					DEFAULT: "rgb(var(--hint-bg) / <alpha-value>)",
					fg: "rgb(var(--hint-fg) / <alpha-value>)",
					border: "rgb(var(--hint-border) / <alpha-value>)",
					typed: "rgb(var(--hint-typed) / <alpha-value>)",
				},
				"stat-gold": "rgb(var(--stat-gold) / <alpha-value>)",
				"stat-fire": "rgb(var(--stat-fire) / <alpha-value>)",
			},
			boxShadow: {
				// Theme-aware card lift: neutral black in dark, soft blue-grey in light
				"card-hover": "var(--shadow-card-hover)",
			},
			keyframes: {
				"slide-in-right": {
					"0%": { transform: "translateX(100%)", opacity: "0" },
					"100%": { transform: "translateX(0)", opacity: "1" },
				},
				"rail-flow": {
					"0%": { transform: "translateY(-120%)" },
					"100%": { transform: "translateY(220%)" },
				},
				// Sticky action bars entering from the bottom edge of a pane.
				"slide-up": {
					"0%": { transform: "translateY(0.5rem)", opacity: "0" },
					"100%": { transform: "translateY(0)", opacity: "1" },
				},
			},
			animation: {
				"slide-in-right": "slide-in-right 0.3s ease-out",
				"rail-flow": "rail-flow 2s ease-in-out infinite",
				"slide-up": "slide-up 0.18s ease-out",
			},
		},
	},
	plugins: [],
};
