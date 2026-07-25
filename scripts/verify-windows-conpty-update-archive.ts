/**
 * Electrobun `postPackage` hook: prove the packaged native host survives inside
 * the FINAL update archive. Lifecycle hooks accept only a script path, so this
 * wrapper selects final-archive mode for `verify-packaged-windows-conpty.ts`.
 *
 * Electrobun runs `postPackage` for every build environment, but `dev` emits no
 * distribution artifacts — there is no `.tar.zst` to inspect. Without this gate a
 * plain `bun run dev` on Windows fails the build before the app is ever launched.
 * Every other environment stays strict, so the release proof cannot become a
 * silent no-op.
 */
import { emitsUpdateArchive } from "../src/shared/electrobun-build-env";

const buildEnvironment = process.env.ELECTROBUN_BUILD_ENV;

if (emitsUpdateArchive(buildEnvironment)) {
	process.env.DEV3_VERIFY_UPDATE_ARCHIVE = "1";
	await import("./verify-packaged-windows-conpty");
} else {
	console.log(
		`[native-terminal-runtime] update-archive proof skipped: the '${buildEnvironment}' build emits no archive`,
	);
}

export {};
