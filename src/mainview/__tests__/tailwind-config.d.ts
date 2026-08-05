// The Tailwind config is plain JS with no types; the collision guard only reads
// `theme.extend`, so a structural shape is enough.
declare module "*/tailwind.config.js" {
	const config: {
		theme: {
			extend: {
				fontSize: Record<string, unknown>;
				colors: Record<string, unknown>;
				backgroundColor: Record<string, unknown>;
				ringColor: Record<string, unknown>;
			};
		};
	};
	export default config;
}
