import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { rejectUnknownFlags } from "../flag-validation";
import { sendRequest } from "../socket-client";
import { CLI_EXIT_CODE_COMMAND_FAILED, CLI_EXIT_CODE_UPDATE_REFUSED } from "../../shared/cli-exit-codes";
import { isProcessAlive, readRemoteState } from "../../bun/remote-state";

/** A full stage+apply, not a question — the default socket timeout is 30 s. */
const SELF_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;

const UPDATE_HELP = `dev3 update — install a newer dev3 on this machine.

Usage:
  dev3 update
  dev3 update --check
  dev3 update --dry-run

What it does:
  Works out how this dev3 was installed — Homebrew formula, Homebrew cask, or a
  plain CLI tarball — and does the right thing for it: \`brew upgrade\`,
  \`brew upgrade --cask\`, or download-and-swap. Nothing else needs configuring.

  If a headless server is running (\`dev3 remote\`), the update is handed to THAT
  process rather than done here, because only it can pass its port and its live
  Cloudflare tunnel to the replacement — which is what keeps the public link and
  your browser session working across the restart. Running agents survive: their
  tmux sessions are detached and task lifecycles are rehydrated on boot.

  With no server running, the files are simply replaced and nothing restarts.

Flags:
  --check     Say whether an update exists and stop. Changes nothing.
  --dry-run   Print the detected install method and exactly what would run,
              then stop. Use this when an update did something surprising —
              a wrong detection shows up here instead of in a post-mortem.

  Both flags ask the running server when there is one, so what they print is the
  plan that would actually be carried out — not this CLI's view of its own path.

Exit codes:
  0   Up to date, or the update was installed / started.
  ${CLI_EXIT_CODE_UPDATE_REFUSED}   Refused, nothing was touched: this install cannot be updated from the CLI
      (running from source, the PATH copy the app maintains, a macOS app bundle
      the CLI does not own, Windows, or a cask whose version has drifted from
      brew's record). The reason is printed.
  1   The update was attempted and failed (download, brew, or the file swap).

Examples:
  dev3 update --check      # is there anything new?
  dev3 update --dry-run    # what would it run, and on which install?
  dev3 update              # do it
`;

export async function handleUpdate(args: ParsedArgs): Promise<void> {
	if (args.flags.help === "true" || args.flags.h === "true") {
		process.stdout.write(UPDATE_HELP);
		return;
	}
	if (args.positional.length > 0) {
		exitUsage(`Unknown positional argument: "${args.positional[0]}"\nRun "dev3 update --help" for usage.`);
	}
	rejectUnknownFlags(args, ["check", "dry-run", "supervise", "help", "h"]);

	// THIS MUST BE SET BEFORE ANY `bun/` IMPORT BELOW. `buildPlan` reaches
	// `./updater`, which statically imports the Electrobun platform shim — and
	// outside headless mode that shim does `import("electrobun/bun")`, whose FFI init
	// starts an HTTP server, prints a version.json stack trace, and calls
	// `process.exit()` when `libNativeWrapper` is not beside the CWD. A plain
	// `dev3 update` is a CLI process with no GUI shell, which is exactly the
	// condition the flag describes.
	process.env.DEV3_HEADLESS = "1";

	// Internal: the relaunch supervisor a self-updating server leaves behind. It runs
	// the OLD binary (that is the point — it has to still work when the new one does
	// not), waits for the server to exit, starts the new build, and rolls back if the
	// new build never reports in. Undocumented in --help on purpose: nobody types it.
	if (args.flags.supervise === "true") {
		return await runSuperviseMode();
	}

	const check = args.flags.check === "true";
	const dryRun = args.flags["dry-run"] === "true";
	if (check && dryRun) {
		exitUsage("--check and --dry-run do the same kind of nothing; pass one or the other.");
	}

	const { buildPlan } = await import("../../bun/self-update");
	const { loadSettings } = await import("../../bun/settings");
	const channel = (await loadSettings()).updateChannel;

	if (check || dryRun) {
		// THE PLAN BELONGS TO WHOEVER WOULD DO THE UPDATE, and with a server running that
		// is the server, not us. Planning locally classified the CLI's OWN path — on any
		// machine the desktop app has ever started, `which dev3` is the app-maintained
		// PATH copy, which the planner refuses. So `--dry-run` reported "nothing was
		// touched, exit 15" on a box where a plain `dev3 update` updates fine, and
		// automation branching on 15 marked it unsupported.
		const delegated = await remoteDryRun();
		if (delegated) {
			process.stdout.write(`Running:        ${delegated.runningVersion}\n`);
			process.stdout.write(`Install method: ${delegated.install}\n`);
			process.stdout.write(`Channel:        ${delegated.channel}\n`);
			if (check) process.stdout.write(`Available:      ${delegated.version ?? "none"}\n`);
			process.stdout.write(`\n${delegated.message}\n`);
			process.exit(delegated.kind === "refused" ? CLI_EXIT_CODE_UPDATE_REFUSED : 0);
		}
		const { install, plan, runningVersion, summary } = await buildPlan(channel);
		process.stdout.write(`Running:        ${runningVersion}\n`);
		process.stdout.write(`Install method: ${install}\n`);
		process.stdout.write(`Channel:        ${channel}\n`);
		if (check) {
			const available = plan.kind === "brew" || plan.kind === "tarball";
			process.stdout.write(available ? `Available:      ${plan.version}\n` : `Available:      none\n`);
		}
		process.stdout.write(`\n${summary}\n`);
		if (plan.kind === "refused") process.exit(CLI_EXIT_CODE_UPDATE_REFUSED);
		process.exit(0);
	}

	// A live headless server owns this update — see the help text above.
	const state = readRemoteState();
	if (state && isProcessAlive(state.pid)) {
		process.stdout.write(`Handing the update to the running server (pid ${state.pid})…\n`);
		let resp: Awaited<ReturnType<typeof sendRequest>>;
		try {
			// The server does the WHOLE update inside this one request — brew fetch, or a
			// release download and extract. The default 30 s would time out on any real
			// network and report a stack trace for an update that then succeeds and
			// restarts the box behind our back.
			resp = await sendRequest(state.socketPath, "remote.selfUpdate", {}, { timeoutMs: SELF_UPDATE_TIMEOUT_MS });
		} catch (err) {
			if (err instanceof Error && err.message === "APP_NOT_RUNNING") {
				exitError(
					`The server (pid ${state.pid}) is not answering on its CLI socket.`,
					"Wait a moment and retry, or `dev3 remote restart` and then update.",
				);
				return;
			}
			throw err;
		}
		if (!resp.ok) exitError(resp.error || "The server refused the update.", undefined, CLI_EXIT_CODE_COMMAND_FAILED);
		const outcome = resp.data as { ok: boolean; refused?: boolean; restarting: boolean; message: string };
		if (!outcome.ok) {
			exitError(outcome.message, undefined, outcome.refused ? CLI_EXIT_CODE_UPDATE_REFUSED : CLI_EXIT_CODE_COMMAND_FAILED);
		}
		process.stdout.write(`${outcome.message}\n`);
		if (outcome.restarting) {
			process.stdout.write(
				"The public tunnel URL and your browser session are kept — the page reconnects on its own.\n" +
				"Follow it with: dev3 remote status\n",
			);
		}
		process.exit(0);
	}

	// Nothing running: install in place, restart nothing.
	const { runSelfUpdate } = await import("../../bun/self-update");
	const outcome = await runSelfUpdate({
		channel,
		restart: false,
		onProgress: (message) => process.stdout.write(`${message}\n`),
	});
	process.stdout.write(`${outcome.message}\n`);
	// 15 means "this install may not be updated from here, nothing was touched"; a
	// download or swap that FAILED is an ordinary failure and must stay 1, or
	// automation branching on 15 to skip unsupported installs swallows real breakage.
	if (outcome.ok) process.exit(0);
	process.exit(outcome.refused ? CLI_EXIT_CODE_UPDATE_REFUSED : CLI_EXIT_CODE_COMMAND_FAILED);
}

interface RemotePlan {
	install: string;
	kind: string;
	runningVersion: string;
	channel: string;
	version: string | null;
	message: string;
}

/**
 * Ask a running headless server for its own plan, or null when there is none to ask.
 *
 * Null is also the answer when the server is there but does not respond — the local
 * plan is a worse answer than none, but a stack trace is worse than both.
 */
async function remoteDryRun(): Promise<RemotePlan | null> {
	const state = readRemoteState();
	if (!state || !isProcessAlive(state.pid)) return null;
	try {
		const resp = await sendRequest(state.socketPath, "remote.selfUpdate", { dryRun: true });
		if (!resp.ok || !resp.data) return null;
		const data = resp.data as Partial<RemotePlan>;
		if (typeof data.install !== "string" || typeof data.kind !== "string") return null;
		return {
			install: data.install,
			kind: data.kind,
			runningVersion: data.runningVersion ?? "unknown",
			channel: data.channel ?? "unknown",
			version: data.version ?? null,
			message: data.message ?? "",
		};
	} catch {
		return null;
	}
}

async function runSuperviseMode(): Promise<void> {
	const { readSuperviseJob, runSupervisor } = await import("../../bun/self-update");
	const job = readSuperviseJob(process.env);
	if (!job) {
		exitError("`dev3 update --supervise` is internal and needs its job in the environment.");
		return;
	}
	const result = await runSupervisor(job);
	process.stdout.write(`${result.message}\n`);
	process.exit(result.ok ? 0 : 1);
}
