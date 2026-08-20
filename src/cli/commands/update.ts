import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { rejectUnknownFlags } from "../flag-validation";
import { sendRequest } from "../socket-client";
import { CLI_EXIT_CODE_UPDATE_REFUSED } from "../../shared/cli-exit-codes";
import { isProcessAlive, readRemoteState } from "../../bun/remote-state";

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

Exit codes:
  0   Up to date, or the update was installed / started.
  ${CLI_EXIT_CODE_UPDATE_REFUSED}   Refused: this install cannot be updated from the CLI (running from
      source, a macOS app bundle the CLI does not own, Windows, or a cask whose
      version has drifted from brew's record). The reason is printed.
  1   The update was attempted and failed.

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
			resp = await sendRequest(state.socketPath, "remote.selfUpdate", {});
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
		if (!resp.ok) exitError(resp.error || "The server refused the update.", undefined, CLI_EXIT_CODE_UPDATE_REFUSED);
		const outcome = resp.data as { ok: boolean; restarting: boolean; message: string };
		if (!outcome.ok) exitError(outcome.message, undefined, CLI_EXIT_CODE_UPDATE_REFUSED);
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
	process.exit(outcome.ok ? 0 : CLI_EXIT_CODE_UPDATE_REFUSED);
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
