import { useEffect, useState } from "react";
import type { AgentCheckResult, CodingAgent } from "../../shared/types";
import { useT } from "../i18n";

/** Where the availability probe stands. `unknown` = the probe itself failed,
 *  which says nothing about the binary and therefore never blocks a launch. */
const CHECKING_REVEAL_MS = 400;

export type AgentCheckState = "checking" | "ready" | "unknown";

/**
 * The first variant whose harness the execution host reported missing. A preset
 * with its own base command is judged at launch, not by its agent's pill — the
 * pill only knows the agent's stock command.
 */
export function findMissingVariantAgent(
	variants: ReadonlyArray<{ agentId: string | null; configId: string | null }>,
	agents: CodingAgent[],
	availability: AgentCheckResult[],
): { agent: CodingAgent; check: AgentCheckResult } | null {
	for (const variant of variants) {
		const agent = agents.find((a) => a.id === variant.agentId);
		if (!agent) continue;
		const config = agent.configurations.find((c) => c.id === variant.configId);
		if (config?.baseCommandOverride) continue;
		const check = availability.find((a) => a.agentId === agent.id);
		if (check && !check.installed) return { agent, check };
	}
	return null;
}

interface AgentInstallNoticeProps {
	id: string;
	state: AgentCheckState;
	missing: { agent: CodingAgent; check: AgentCheckResult } | null;
	/** Name of a harness that was missing and a recheck just found. */
	installedNow: string | null;
	onRecheck: () => void;
}

/** Inline availability notice under the launch picker: the install command for a
 *  missing harness, and the re-check that lifts the block once it is installed. */
export default function AgentInstallNotice({ id, state, missing, installedNow, onRecheck }: AgentInstallNoticeProps) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const checking = state === "checking";
	const command = missing?.check.installCommand;

	useEffect(() => setCopied(false), [command]);

	// A sub-second probe would only flash a line and shift the dialog.
	const [slowCheck, setSlowCheck] = useState(false);
	useEffect(() => {
		if (!checking) { setSlowCheck(false); return; }
		const id = setTimeout(() => setSlowCheck(true), CHECKING_REVEAL_MS);
		return () => clearTimeout(id);
	}, [checking]);

	function copy() {
		if (!command) return;
		navigator.clipboard.writeText(command).then(() => setCopied(true), () => {});
	}

	const recheckButton = (
		<button
			type="button"
			data-testid="agent-install-recheck"
			onClick={onRecheck}
			disabled={checking}
			aria-disabled={checking || undefined}
			className="text-xs font-medium px-2.5 py-1 rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-elevated disabled:opacity-60 whitespace-nowrap"
		>
			{checking ? t("launch.agentChecking") : t("launch.agentCheckAgain")}
		</button>
	);

	if (missing) {
		return (
			<div id={id} data-testid="agent-install-notice" className="p-3 rounded-lg bg-warning/10 border border-warning/20 space-y-2">
				<p className="text-warning-strong text-xs font-medium">
					{t("launch.agentMissingTitle", { name: missing.agent.name })}. {t("launch.agentMissingBlocked")}
				</p>
				{command ? (
					<>
						<p className="text-fg-2 text-xs">{t("launch.agentMissingInstall")}</p>
						<div className="flex items-center gap-2 min-w-0">
							<code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap text-warning-strong bg-warning/10 px-2 py-1 rounded text-xs font-mono select-all">
								{command}
							</code>
							<button
								type="button"
								onClick={copy}
								className="text-xs font-medium px-2.5 py-1 rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-elevated whitespace-nowrap"
							>
								{copied ? t("launch.agentCopied") : t("launch.agentCopyInstall")}
							</button>
						</div>
					</>
				) : (
					<p className="text-fg-2 text-xs">{t("launch.agentMissingNoCommand", { command: missing.check.baseCommand })}</p>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-fg-3 text-xs">{t("launch.agentMissingPathHint")}</p>
					{recheckButton}
				</div>
			</div>
		);
	}

	if (state === "unknown") {
		return (
			<div id={id} data-testid="agent-install-unknown" className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
				<p>{t("launch.agentCheckUnknown")}</p>
				{recheckButton}
			</div>
		);
	}

	if (checking) {
		return slowCheck ? <p role="status" aria-live="polite" className="text-xs text-fg-3">{t("launch.agentChecking")}</p> : null;
	}
	if (!installedNow) return null;
	return (
		<p role="status" aria-live="polite" className="text-xs text-success-strong">
			✓ {t("launch.agentInstalledNow", { name: installedNow })}
		</p>
	);
}
