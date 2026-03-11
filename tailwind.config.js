/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/mainview/**/*.{html,js,ts,jsx,tsx}"],
	theme: {
		extend: {
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
				},
				danger: "rgb(var(--danger) / <alpha-value>)",
				success: {
					DEFAULT: "rgb(var(--success) / <alpha-value>)",
					hover: "rgb(var(--success-hover) / <alpha-value>)",
				},
			},
			keyframes: {
				"slide-in-right": {
					"0%": { transform: "translateX(100%)", opacity: "0" },
					"100%": { transform: "translateX(0)", opacity: "1" },
				},
			},
			animation: {
				"slide-in-right": "slide-in-right 0.3s ease-out",
			},
		},
	},
	plugins: [],
};
