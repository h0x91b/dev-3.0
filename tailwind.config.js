/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/mainview/**/*.{html,js,ts,jsx,tsx}"],
	theme: {
		extend: {
			// The rung below `text-xs` that dense chips and meta lines kept
			// re-inventing as `text-[0.625rem]` / `text-[0.65rem]` / `text-[0.6875rem]`.
			// Arbitrary sizes also set no line-height, so they inherited the
			// ancestor's leading; this rung carries its own.
			fontSize: {
				micro: ["0.6875rem", { lineHeight: "1.4" }],
			},
			fontFamily: {
				mono: [
					"'JetBrainsMono Nerd Font Mono'",
					"'SF Mono'",
					"Menlo",
					"monospace",
				],
			},
			colors: {
				base: "rgb(var(--surface-base) / <alpha-value>)",
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
				},
				danger: "rgb(var(--danger) / <alpha-value>)",
				"danger-strong": "rgb(var(--danger-strong) / <alpha-value>)",
				"success-strong": "rgb(var(--success-strong) / <alpha-value>)",
				warning: "rgb(var(--warning) / <alpha-value>)",
				"warning-strong": "rgb(var(--warning-strong) / <alpha-value>)",
				favorite: "rgb(var(--favorite) / <alpha-value>)",
				awake: {
					DEFAULT: "rgb(var(--awake) / <alpha-value>)",
					hover: "rgb(var(--awake-hover) / <alpha-value>)",
				},
				success: {
					DEFAULT: "rgb(var(--success) / <alpha-value>)",
					hover: "rgb(var(--success-hover) / <alpha-value>)",
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
