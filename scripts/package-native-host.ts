/**
 * Electrobun `postBuild` hook: assemble and prove this package's native terminal
 * host image. Lifecycle hooks accept a single script path, so the platform split
 * lives here rather than in the config.
 *
 * Windows keeps its richer ConPTY proof (tasklist image names, PowerShell child,
 * update-archive re-verification in `postPackage`); macOS and Linux get the
 * equivalent assemble + stage + detached-lifecycle proof.
 */

if (process.platform === "win32") {
	// Electrobun's own icon step already ran and silently failed; redo it here,
	// before the bundle is archived. See
	// decisions/214-vendor-rcedit-for-windows-icons.md.
	await import("./embed-windows-icons");
	await import("./verify-packaged-windows-conpty");
} else await import("./package-posix-native-host");

export {};
