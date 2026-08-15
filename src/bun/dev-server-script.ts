/**
 * The dev-server pane's wrapper script, authored in the platform launch dialect
 * (Seq 1546).
 *
 * It used to be hand-written bash stitched together inside `runDevServer`: a
 * `#!/bin/bash` shebang, `set -x`, `[ $EXIT_CODE -ne 0 ]`, `read -n 1 -s`. On
 * Windows the pane launched that text through `/bin/bash`, a path that does not
 * exist there — which is why the whole feature was dead on that platform.
 *
 * ONE thing this file does NOT solve, and cannot: {@link DevServerScriptOptions.devScript}
 * is the USER's own command, written in whatever shell they had in mind. dev3
 * spells the wrapper; it does not translate the body. A `VITE_PORT=${DEV3_PORT0}
 * bun run dev` remains POSIX text no matter which dialect surrounds it, and under
 * PowerShell it fails as a parse error. The wrapper's job is to stop being the
 * thing that breaks, and to make that failure the user's script rather than a
 * missing `/bin/bash`.
 */

import { indentLines, launchDialect } from "../shared/platform-launch";

export interface DevServerScriptOptions {
	/** The project's dev command, verbatim — see the file note above. */
	devScript: string;
	/**
	 * Environment blocks, in order. Each becomes its own paragraph so the pane's
	 * trace reads as project env / task env / ports rather than one wall.
	 */
	envGroups: Record<string, string>[];
	/**
	 * tmux only: the command that detaches the outer viewer client before this
	 * pane closes, which keeps the inner tmux redraw from corrupting the outer
	 * one. A native pane has no nesting and no tmux binary, so it passes null —
	 * and on Windows there is no tmux at all.
	 */
	tmuxDetachCommand?: string | null;
}

const EXIT_CODE_VAR = "EXIT_CODE";

/** The wrapper text for one dev-server pane, in the current platform's dialect. */
export function buildDevServerScript(options: DevServerScriptOptions): string {
	const d = launchDialect();
	const envParagraphs = options.envGroups
		.filter((group) => Object.keys(group).length > 0)
		.flatMap((group) => [...d.envLines(group), ""]);
	const failNotice = d.print("Process exited with code %s. Press any key to close.", {
		blankBefore: true,
		args: [d.exitCodeArg(EXIT_CODE_VAR)],
	});
	return [
		...d.header(),
		...envParagraphs,
		// Only the user's command is traced: the exports above are dev3's business.
		d.traceOn(),
		options.devScript,
		d.captureExitCode(EXIT_CODE_VAR),
		d.traceOff(),
		...d.branchOnFailure(EXIT_CODE_VAR, { fail: indentLines(2, [failNotice, d.readKey()]) }),
		...(options.tmuxDetachCommand ? [options.tmuxDetachCommand] : []),
	].join("\n") + "\n";
}
