/**
 * Electrobun `postBuild` hook: assemble and prove this package's native terminal
 * host image. Lifecycle hooks accept a single script path, so the platform split
 * lives here rather than in the config.
 *
 * Windows keeps its richer ConPTY proof (tasklist image names, PowerShell child,
 * update-archive re-verification in `postPackage`); macOS and Linux get the
 * equivalent assemble + stage + detached-lifecycle proof.
 */

if (process.platform === "win32") await import("./verify-packaged-windows-conpty");
else await import("./package-posix-native-host");

export {};
